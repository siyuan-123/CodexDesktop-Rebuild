#!/usr/bin/env node
/**
 * 为简体中文推理强度名称补充实际协议参数，并明确 Ultra 的特殊语义。
 *
 * 上游语言包由构建产物生成，文件名包含哈希，直接修改会在下次同步时丢失。
 * 本补丁按稳定的 i18n 消息 ID 定位文本，兼容命名模块与 Rspack JSON 语言包。
 *
 * Usage:
 *   node scripts/patch-reasoning-effort-labels.js [platform]
 *   node scripts/patch-reasoning-effort-labels.js --check
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath, listJavaScriptFiles } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

const TRANSLATION_SPECS = Object.freeze([
  { messageIds: ["composer.mode.local.reasoning.none.label"], translation: "无（none）" },
  { messageIds: ["composer.mode.local.reasoning.minimal.label"], translation: "极低（minimal）" },
  {
    // 26.803 将 low 的消息 ID 升级为 v2；保留旧 ID 以兼容历史安装包。
    messageIds: [
      "composer.mode.local.reasoning.low.label.v2",
      "composer.mode.local.reasoning.low.label",
    ],
    translation: "轻度（low）",
  },
  { messageIds: ["composer.mode.local.reasoning.medium.label"], translation: "中（medium）" },
  { messageIds: ["composer.mode.local.reasoning.high.label"], translation: "高（high）" },
  { messageIds: ["composer.mode.local.reasoning.xhigh.label"], translation: "极高（xhigh）" },
  { messageIds: ["composer.mode.local.reasoning.max.label"], translation: "最高（max）" },
  { messageIds: ["composer.mode.local.reasoning.ultra.label"], translation: "Ultra（ultra）" },
  {
    messageIds: ["composer.modelPicker.power.ultraUsageWarning"],
    translation: "自动任务委派，更快消耗使用额度",
  },
]);

const TRANSLATIONS = Object.freeze(
  Object.fromEntries(
    TRANSLATION_SPECS.map(({ messageIds, translation }) => [messageIds[0], translation]),
  ),
);

function escapeTemplateLiteral(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function findTemplateLiteralEnd(source, start) {
  for (let index = start; index < source.length; index++) {
    if (source[index] !== "`") continue;

    let backslashes = 0;
    for (let cursor = index - 1; cursor >= start && source[cursor] === "\\"; cursor--) {
      backslashes++;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function findOccurrences(source, marker) {
  const indexes = [];
  let offset = 0;
  while ((offset = source.indexOf(marker, offset)) !== -1) {
    indexes.push(offset);
    offset += marker.length;
  }
  return indexes;
}

function walk(node, visit) {
  if (!node?.type) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function patchJsonLocale(source) {
  if (!source.includes("JSON.parse")) return null;
  const payloads = [];
  walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
    if (node.type !== "CallExpression" || node.callee.object?.name !== "JSON" ||
        node.callee.property?.name !== "parse" || typeof node.arguments[0]?.value !== "string") return;
    const literal = node.arguments[0];
    const messages = JSON.parse(literal.value);
    if (messages && Object.hasOwn(messages, "composer.mode.local.reasoning.none.label")) {
      payloads.push({ literal, messages });
    }
  });
  if (payloads.length === 0) return null;
  if (payloads.length !== 1) return { status: "unexpected-entry-count", source,
    invalidEntries: [{ messageId: "JSON locale payload", count: payloads.length }] };
  const [{ literal, messages }] = payloads;
  const patches = [], invalidEntries = [];
  for (const { messageIds, translation } of TRANSLATION_SPECS) {
    const candidates = messageIds.filter((id) => Object.hasOwn(messages, id));
    if (candidates.length !== 1 || typeof messages[candidates[0]] !== "string") {
      invalidEntries.push({ messageId: messageIds.join(" or "), count: candidates.length });
      continue;
    }
    const [messageId] = candidates;
    if (messages[messageId] !== translation) {
      patches.push({ messageId, original: messages[messageId], replacement: translation });
      messages[messageId] = translation;
    }
  }
  if (invalidEntries.length) return { status: "unexpected-entry-count", invalidEntries, source };
  if (!patches.length) return { status: "already-patched", patches, source };
  const next = source.slice(0, literal.start) + JSON.stringify(JSON.stringify(messages)) + source.slice(literal.end);
  parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return { status: "patched", patches, source: next };
}

function patchSource(source) {
  const jsonResult = patchJsonLocale(source);
  if (jsonResult) return jsonResult;
  const patches = [];
  const invalidEntries = [];

  for (const { messageIds, translation } of TRANSLATION_SPECS) {
    const candidates = messageIds.flatMap((messageId) => {
      const marker = `"${messageId}":\``;
      return findOccurrences(source, marker).map((offset) => ({ messageId, marker, offset }));
    });
    if (candidates.length !== 1) {
      invalidEntries.push({ messageId: messageIds.join(" or "), count: candidates.length });
      continue;
    }

    const [{ messageId, marker, offset }] = candidates;
    const start = offset + marker.length;
    const end = findTemplateLiteralEnd(source, start);
    if (end === -1) {
      invalidEntries.push({ messageId, count: 0, unterminated: true });
      continue;
    }

    const replacement = escapeTemplateLiteral(translation);
    const original = source.slice(start, end);
    if (original !== replacement) {
      patches.push({ messageId, start, end, original, replacement });
    }
  }

  if (invalidEntries.length > 0) {
    return {
      status: "unexpected-entry-count",
      invalidEntries,
      source,
    };
  }

  if (patches.length === 0) {
    return { status: "already-patched", patches, source };
  }

  let nextSource = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    nextSource =
      nextSource.slice(0, patch.start) +
      patch.replacement +
      nextSource.slice(patch.end);
  }

  try {
    parse(nextSource, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-failed", error, patches, source };
  }

  return { status: "patched", patches, source: nextSource };
}

function getPlatforms(platform, srcDir) {
  if (platform) return [platform];
  return PLATFORMS.filter((item) =>
    fs.existsSync(path.join(srcDir, item, "_asar", "webview", "assets")),
  );
}

/** 从真实 locale 导入映射定位中文分片，避免根据翻译文字猜测语言。 */
function findLocaleBundles(assetsDir) {
  const files = listJavaScriptFiles(assetsDir);
  const named = files.filter((file) => /^zh-CN-.*\.js$/.test(path.basename(file)));
  if (named.length) return named;
  const chunkIds = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(assetsDir, file), "utf8");
    if (!source.includes("../locales/zh-CN.json")) continue;
    walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
      if (node.type !== "Property" || node.key.value !== "../locales/zh-CN.json") return;
      walk(node.value, (call) => {
        if (call.type === "CallExpression" && call.callee.property?.name === "e" &&
            typeof call.arguments[0]?.value === "number") chunkIds.add(String(call.arguments[0].value));
      });
    });
  }
  return files.filter((file) => chunkIds.has(path.basename(file).split(".")[0]));
}

function findTargets(platform, srcDir = SRC_DIR) {
  const targets = [];
  const invalidPlatforms = [];

  for (const currentPlatform of getPlatforms(platform, srcDir)) {
    const assetsDir = path.join(
      srcDir,
      currentPlatform,
      "_asar",
      "webview",
      "assets",
    );
    const files = findLocaleBundles(assetsDir);

    if (files.length !== 1) {
      invalidPlatforms.push({ platform: currentPlatform, count: files.length });
      continue;
    }

    targets.push({
      platform: currentPlatform,
      path: path.join(assetsDir, files[0]),
    });
  }

  return { invalidPlatforms, targets };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((item) => PLATFORMS.includes(item));
  const { invalidPlatforms, targets } = findTargets(platform);
  let failed = invalidPlatforms.length;
  let changed = 0;

  for (const item of invalidPlatforms) {
    console.log(
      `  [x] ${item.platform}: expected 1 zh-CN bundle, found ${item.count}`,
    );
  }

  if (targets.length === 0 && invalidPlatforms.length === 0) {
    console.log("  [skip] No generated platform sources found");
    return;
  }

  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf-8");
    const result = patchSource(source);
    const label = relPath(target.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }

    if (result.status === "unexpected-entry-count") {
      for (const entry of result.invalidEntries) {
        const reason = entry.unterminated
          ? "unterminated template literal"
          : `expected 1 entry, found ${entry.count}`;
        console.log(`  [x] ${label}: ${entry.messageId}: ${reason}`);
      }
      failed++;
      continue;
    }

    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: post-patch parse failed: ${result.error.message}`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${label}: would update ${result.patches.length} translation(s)`,
      );
    } else {
      fs.writeFileSync(target.path, result.source, "utf-8");
      console.log(
        `  [ok] ${label}: updated ${result.patches.length} translation(s)`,
      );
    }
    changed++;
  }

  console.log(
    `  [done] ${isCheck ? "would patch" : "patched"} ${changed} file(s)`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { TRANSLATIONS, TRANSLATION_SPECS, findTargets, findLocaleBundles, patchSource };

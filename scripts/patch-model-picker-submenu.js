#!/usr/bin/env node
/**
 * 让高级模型选择器中的模型列表使用点击展开的内联子菜单。
 *
 * Electron 原先使用 FlyoutSubmenuItem。模型列表与父菜单分属两个 Portal，
 * 指针跨越两者间隙时会触发悬浮关闭，导致模型项很难点中。模型项本来就会
 * preventDefault 保持选择器打开，因此改为内联子菜单后，选择会立即勾选，
 * 并仅在用户点击选择器外部时关闭。
 *
 * Usage:
 *   node scripts/patch-model-picker-submenu.js [platform]
 *   node scripts/patch-model-picker-submenu.js --check
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const MARKER = "/* Codex：模型选择器改用稳定的点击展开。 */";
const TARGET_SIGNATURES = [
  "FlyoutSubmenuItem",
  "flyoutHeader",
  "chromeExtension:!0,extension:!0",
  "contentClassName:`w-[233px]`",
];

// 高级选择器行组件先构造 SubmenuItem，再按运行平台选择内联或 Flyout 渲染。
const INLINE_BRANCH_RE =
  /let ([\w$]+)=([\w$]+);if\(([\w$]+)\(\)\)return \1;let ([\w$]+);/g;
const ROW_PROPS_RE =
  /\{ariaLabel:[\w$]+,label:([\w$]+),value:[\w$]+,children:[\w$]+,disabled:[\w$]+,contentClassName:[\w$]+,flyoutHeader:[\w$]+\}=[\w$]+/g;
const LEGACY_CONDITION_RE =
  /if\(([\w$]+)\(\)\|\|([\w$]+)\?\.props\?\.\[`data-model-picker-model-row`\]===!0\)/g;

function getPlatforms(platform) {
  if (platform) return [platform];
  return PLATFORMS.filter((item) =>
    fs.existsSync(path.join(SRC_DIR, item, "_asar", "webview", "assets")),
  );
}

function findTargets(platform) {
  const targets = [];
  for (const currentPlatform of getPlatforms(platform)) {
    const assetsDir = path.join(
      SRC_DIR,
      currentPlatform,
      "_asar",
      "webview",
      "assets",
    );
    if (!fs.existsSync(assetsDir)) continue;

    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf-8");
      if (TARGET_SIGNATURES.every((signature) => source.includes(signature))) {
        targets.push({ platform: currentPlatform, path: filePath, source });
      }
    }
  }
  return targets;
}

function parseOk(code) {
  try {
    acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    return true;
  } catch {
    return false;
  }
}

function patchSource(source) {
  const rowPropsMatches = [...source.matchAll(ROW_PROPS_RE)];
  if (rowPropsMatches.length !== 1) {
    return {
      status: "unexpected-row-props-count",
      count: rowPropsMatches.length,
      source,
    };
  }
  const labelVariable = rowPropsMatches[0][1];

  if (source.includes(MARKER)) {
    const legacyMatches = [...source.matchAll(LEGACY_CONDITION_RE)];
    if (legacyMatches.length === 0) return { status: "already-patched", source };
    if (legacyMatches.length !== 1) {
      return {
        status: "unexpected-legacy-condition-count",
        count: legacyMatches.length,
        source,
      };
    }
    const nativeInlineCheck = legacyMatches[0][1];
    const safeCondition =
      `if(${labelVariable}?.props?.[\`data-model-picker-model-row\`]===!0||` +
      `typeof ${nativeInlineCheck}===\`function\`&&${nativeInlineCheck}())`;
    const next = source.replace(legacyMatches[0][0], safeCondition);
    if (!parseOk(next)) return { status: "parse-failed", source };
    return { status: "upgraded", source: next };
  }

  const matches = [...source.matchAll(INLINE_BRANCH_RE)];
  if (matches.length !== 1) {
    return { status: "unexpected-anchor-count", count: matches.length, source };
  }

  const [match, inlineValue, submenuValue, nativeInlineCheck, nextVariable] =
    matches[0];
  const replacement =
    `${MARKER}let ${inlineValue}=${submenuValue};` +
    `if(${labelVariable}?.props?.[\`data-model-picker-model-row\`]===!0||` +
    `typeof ${nativeInlineCheck}===\`function\`&&${nativeInlineCheck}())` +
    `return ${inlineValue};let ${nextVariable};`;
  const next = source.replace(match, replacement);

  if (!parseOk(next)) return { status: "parse-failed", source };
  return { status: "patched", source: next };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((item) => PLATFORMS.includes(item));
  const targets = findTargets(platform);

  if (targets.length === 0) {
    console.log("  [skip] No model picker submenu bundle found");
    return;
  }

  let patched = 0;
  let failed = 0;
  for (const target of targets) {
    const label = relPath(target.path);
    const result = patchSource(target.source);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }
    if (result.status === "upgraded") {
      if (isCheck) {
        console.log(`  [?] ${label}: would upgrade the submenu guard`);
      } else {
        fs.writeFileSync(target.path, result.source, "utf-8");
        console.log(`  [ok] ${label}: upgraded submenu guard`);
      }
      patched++;
      continue;
    }
    if (result.status === "unexpected-anchor-count") {
      console.log(
        `  [x] ${label}: expected 1 inline submenu branch, found ${result.count}`,
      );
      failed++;
      continue;
    }
    if (result.status === "unexpected-row-props-count") {
      console.log(
        `  [x] ${label}: expected 1 picker row signature, found ${result.count}`,
      );
      failed++;
      continue;
    }
    if (result.status === "unexpected-legacy-condition-count") {
      console.log(
        `  [x] ${label}: expected 1 legacy submenu guard, found ${result.count}`,
      );
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: post-patch parse failed`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [?] ${label}: would stabilize the model submenu`);
    } else {
      fs.writeFileSync(target.path, result.source, "utf-8");
      console.log(`  [ok] ${label}: model submenu now opens inline`);
    }
    patched++;
  }

  console.log(
    `  [done] ${isCheck ? "would patch" : "patched"} ${patched} file(s)`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { findTargets, patchSource };

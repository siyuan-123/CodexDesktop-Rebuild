/**
 * Post-build patch: Update copyright text
 *
 * 兼容两种上游实现：旧版 setAboutPanelOptions 的 copyright 属性，以及
 * 26.803 起自定义 About HTML 中的 copyright 节点。
 *
 * Usage:
 *   node scripts/patch-copyright.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-copyright.js --check       # Dry-run: report matches
 */
const fs = require("fs");
const { parse } = require("acorn");
const { locateBuildTargets, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  Config
// ──────────────────────────────────────────────

const OLD_COPYRIGHT = "\u00A9 OpenAI"; // (c) OpenAI
const NEW_COPYRIGHT = "\u00A9 OpenAI \u00B7 Cometix Space"; // (c) OpenAI . Cometix Space
const OLD_COPYRIGHT_HTML = `<div class="copyright">${OLD_COPYRIGHT}</div>`;
const NEW_COPYRIGHT_HTML = `<div class="copyright">${NEW_COPYRIGHT}</div>`;
// 新版 About HTML 由模板源码生成，版权符号以 \xa9 转义形式保存。
const OLD_COPYRIGHT_HTML_ESCAPED = `<div class="copyright">\\xa9 OpenAI</div>`;
const NEW_COPYRIGHT_HTML_ESCAPED = `<div class="copyright">\\xa9 OpenAI · Cometix Space</div>`;

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walk(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

function collectPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "Property") return;
    const keyName =
      node.key.type === "Identifier"
        ? node.key.name
        : node.key.type === "Literal"
          ? node.key.value
          : null;
    if (keyName !== "copyright") return;

    const val = node.value;

    // Case 1: Literal string  copyright: "..."
    if (val.type === "Literal" && val.value === OLD_COPYRIGHT) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: JSON.stringify(NEW_COPYRIGHT),
        original: source.slice(val.start, val.end),
      });
      return;
    }

    // Case 2: Template literal  copyright: `...`  (no expressions, single quasi)
    if (
      val.type === "TemplateLiteral" &&
      val.expressions.length === 0 &&
      val.quasis.length === 1 &&
      val.quasis[0].value.cooked === OLD_COPYRIGHT
    ) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: "`" + NEW_COPYRIGHT + "`",
        original: source.slice(val.start, val.end),
      });
      return;
    }
  });

  // 26.803 起 About 面板改成自定义 HTML，不再调用 setAboutPanelOptions。
  let offset = 0;
  while ((offset = source.indexOf(OLD_COPYRIGHT_HTML, offset)) !== -1) {
    patches.push({
      start: offset,
      end: offset + OLD_COPYRIGHT_HTML.length,
      replacement: NEW_COPYRIGHT_HTML,
      original: OLD_COPYRIGHT_HTML,
    });
    offset += OLD_COPYRIGHT_HTML.length;
  }

  offset = 0;
  while ((offset = source.indexOf(OLD_COPYRIGHT_HTML_ESCAPED, offset)) !== -1) {
    patches.push({
      start: offset,
      end: offset + OLD_COPYRIGHT_HTML_ESCAPED.length,
      replacement: NEW_COPYRIGHT_HTML_ESCAPED,
      original: OLD_COPYRIGHT_HTML_ESCAPED,
    });
    offset += OLD_COPYRIGHT_HTML_ESCAPED.length;
  }

  return patches;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  // About 面板可能拆到任意 chunk，按内容定位并保留旧版兼容。
  const bundles = locateBuildTargets({
    platform,
    label: "About copyright",
    test: (source) => source.includes(OLD_COPYRIGHT_HTML) || source.includes(NEW_COPYRIGHT_HTML) ||
      source.includes(OLD_COPYRIGHT_HTML_ESCAPED) || source.includes(NEW_COPYRIGHT_HTML_ESCAPED) ||
      /copyright\s*:\s*["'`]/.test(source),
  });

  if (bundles.length === 0) {
    console.error("[x] No main bundle found");
    process.exit(1);
  }

  for (const bundle of bundles) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      // Check if already patched
      if (source.includes(NEW_COPYRIGHT) || source.includes(NEW_COPYRIGHT_HTML_ESCAPED)) {
        console.log("   [ok] Already patched");
      } else {
        throw new Error(`No copyright property matched in ${relPath(bundle.path)}`);
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    parse(code, { ecmaVersion: "latest", sourceType: "module" });
    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] Copyright updated: ${patches.length} replacements`);
  }
}

if (require.main === module) main();

module.exports = {
  NEW_COPYRIGHT,
  NEW_COPYRIGHT_HTML,
  OLD_COPYRIGHT,
  OLD_COPYRIGHT_HTML,
  OLD_COPYRIGHT_HTML_ESCAPED,
  collectPatches,
  NEW_COPYRIGHT_HTML_ESCAPED,
};

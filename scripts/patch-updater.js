#!/usr/bin/env node
/**
 * patch-updater.js — Disable Sparkle (macOS) and Windows auto-updater
 *
 * 按方法名查找更新器策略，兼容对象方法、函数表达式和新版箭头函数。
 * macOS / Windows / Linux 的更新器均返回 false，避免覆盖重建补丁。
 *
 * Specifically targets:
 *   shouldIncludeSparkle(e,t,n){return ...}  → return !1
 *   shouldIncludeWindowsUpdater(e,t,n){return ...}  → return !1
 *   shouldIncludeUpdater(e,t,n){return ...}  → return !1
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const UPDATER_METHODS = new Set([
  "shouldIncludeSparkle",
  "shouldIncludeWindowsUpdater",
  "shouldIncludeWindowsMsixUpdater",
  "shouldIncludeLinuxPackageUpdater",
  "shouldIncludeUpdater",
]);

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child)
        if (item && typeof item === "object" && item.type) walk(item, visitor);
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match: Property with key being an updater method name and value being a FunctionExpression
    if (node.type !== "Property") return;
    const keyName = node.key?.name || node.key?.value;
    if (!UPDATER_METHODS.has(keyName)) return;

    const fn = node.value;
    if (!["FunctionExpression", "ArrowFunctionExpression"].includes(fn?.type)) return;
    const body = fn.body;
    let expression = body;
    if (body?.type === "BlockStatement") {
      if (body.body.length !== 1) throw new Error(`Unexpected updater body: ${keyName}`);
      const ret = body.body[0];
      if (ret.type !== "ReturnStatement" || !ret.argument) throw new Error(`Unexpected updater return: ${keyName}`);
      expression = ret.argument;
    }

    const retSrc = source.slice(expression.start, expression.end);
    if (retSrc === "!1" || retSrc === "false") return;

    patches.push({
      id: keyName,
      start: expression.start,
      end: expression.end,
      replacement: "!1",
      original: retSrc.length > 50 ? retSrc.slice(0, 47) + "..." : retSrc,
    });
  });

  return patches;
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
      );

  const targets = [];
  for (const plat of platforms) {
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) continue;
    for (const f of fs.readdirSync(buildDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(buildDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (
        src.includes("shouldIncludeSparkle") &&
        src.includes("shouldIncludeUpdater")
      ) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));
  const check = args.includes("--check");

  const targets = locateTargets(platform);
  if (targets.length === 0) {
    console.log("  [ok] No updater targets found");
    return;
  }

  for (const bundle of targets) {
    console.log(`  [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      console.log("    [ok] Already patched or no match");
      continue;
    }

    patches.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of patches) {
      console.log(`    * [${p.id}] ${p.original} -> !1`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    // 检查模式只报告，避免升级预检提前改写上游资源。
    parse(code, { ecmaVersion: "latest", sourceType: "module" });
    if (!check) fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`    [${check ? "?" : "ok"}] ${patches.length} updater methods ${check ? "would be disabled" : "disabled"}`);
  }
}

if (require.main === module) main();

module.exports = { collectPatches };

#!/usr/bin/env node
/**
 * 确保打包后的 Electron 进程把已解析的 Codex home 写回 CODEX_HOME。
 * 上游启动代码有两类形态：
 *   1. 旧版 main bootstrap 直接 await app-server；
 *   2. 新版 computer-use/native-pipe 启动函数通过 codexHome 参数传递，
 *      兼容具名函数、匿名函数和箭头函数及任意 chunk 文件名。
 *
 * 如果不补齐环境变量，Windows 子进程可能回退到内置 catalog，
 * 从而忽略用户 ~/.codex 下的配置与 catalog。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");

const args = process.argv.slice(2);
const check = args.includes("--check");
const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

const repoRoot = path.resolve(__dirname, "..");
const targets = platform
  ? [platform]
  : ["mac-arm64", "mac-x64", "win"].filter((p) =>
      fs.existsSync(path.join(repoRoot, "src", p, "_asar", ".vite", "build")),
    );

const LEGACY_OLD = "let j=r.E({moduleDir:__dirname});await Yp(j.codexHome)";
const LEGACY_NEW =
  "let j=r.E({moduleDir:__dirname});process.env.CODEX_HOME??=j.codexHome;await Yp(j.codexHome)";

function walk(node, visit) {
  if (!node?.type) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function findNativePipeStarts(src) {
  if (!src.includes("codexHome") || !src.includes("startServer")) return [];
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  const matches = [];
  walk(ast, (node) => {
    if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) return;
    const options = node.params[0];
    if (options?.type !== "ObjectPattern" || node.body.type !== "BlockStatement") return;
    const property = (name) => options.properties.find((item) =>
      item.type === "Property" && (item.key.name || item.key.value) === name);
    const home = property("codexHome")?.value;
    if (home?.type !== "AssignmentPattern" || home.left.type !== "Identifier" || !property("startServer")) return;
    matches.push({ body: node.body, name: home.left.name });
  });
  return matches;
}

function countLiteral(src, needle) {
  return src.split(needle).length - 1;
}

function patchSource(src, file) {
  if (src.includes(LEGACY_NEW)) {
    return { matched: true, changed: false, source: src, label: "legacy bootstrap already patched" };
  }

  const legacyCount = countLiteral(src, LEGACY_OLD);
  if (legacyCount > 0) {
    if (legacyCount !== 1) {
      throw new Error(`Expected one legacy Codex home startup marker in ${file}, found ${legacyCount}`);
    }
    return {
      matched: true,
      changed: true,
      source: src.replace(LEGACY_OLD, LEGACY_NEW),
      label: "legacy bootstrap",
    };
  }

  const matches = findNativePipeStarts(src);
  if (matches.length > 0) {
    if (matches.length !== 1) {
      throw new Error(`Expected one native-pipe Codex home startup marker in ${file}, found ${matches.length}`);
    }
    const { body, name } = matches[0];
    const insertion = `process.env.CODEX_HOME??=${name};`;
    if (src.slice(body.start + 1, body.end).startsWith(insertion)) {
      return { matched: true, changed: false, source: src, label: "native-pipe bootstrap already patched" };
    }
    const source = src.slice(0, body.start + 1) + insertion + src.slice(body.start + 1);
    parse(source, { ecmaVersion: "latest", sourceType: "module" });
    return {
      matched: true,
      changed: true,
      source,
      label: "native-pipe bootstrap",
    };
  }

  return { matched: false, changed: false, source: src, label: null };
}

function patchFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const result = patchSource(src, file);
  if (!result.matched) return { matched: false, changed: false };
  if (!result.changed) {
    console.log(`[ok] already patched (${result.label}): ${file}`);
    return { matched: true, changed: false };
  }
  if (check) {
    console.log(`[check] would patch (${result.label}): ${file}`);
    return { matched: true, changed: true };
  }
  fs.writeFileSync(file, result.source, "utf8");
  console.log(`[ok] patched (${result.label}): ${file}`);
  return { matched: true, changed: true };
}

function main() {
  if (targets.length === 0) throw new Error("No generated platform sources found for Codex home patch");
  let changed = 0;
  for (const target of targets) {
    const buildDir = path.join(repoRoot, "src", target, "_asar", ".vite", "build");
    const files = fs
      .readdirSync(buildDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => path.join(buildDir, name));

    let matched = false;
    for (const file of files) {
      const result = patchFile(file);
      if (!result.matched) continue;
      matched = true;
      if (result.changed) changed++;
    }
    if (!matched) throw new Error(`No Codex home startup marker found for ${target}`);
  }
  console.log(check ? `[check] ${changed} file(s) need patching` : `[done] ${changed} file(s) patched`);
}

if (require.main === module) main();

module.exports = { patchSource };

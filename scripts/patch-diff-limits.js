#!/usr/bin/env node
/**
 * patch-diff-limits.js — 收紧 git diff 单命令输出上限 32MB -> 8MB（治本缓解）
 *
 * 背景：2026-07-04 22:22 崩溃取证实锤 worker.js 在执行 diff 类任务时
 * V8 堆暴涨到 2.8GB（large_object_space 破 1GB）。代码审查发现：
 *   - git 执行器 $ 支持 maxOutputBytes，超限即 kill 并报 outputLimitExceeded，
 *     上游统一映射为 diff-too-large 错误（业务已有该错误的处理与 UI 文案）；
 *   - diff 封装 b2 的兜底上限 A1=32MB，且最多 8 路并发（F1=8）拉不同文件
 *     的 diff，每路结果同时持有 Uint8Array buffer + 解码后 string 双副本，
 *     再叠加 queryClient 的短期缓存 —— 32MB 上限下瞬时驻留可达数百 MB，
 *     GC 追不上时滚雪球，最终 native OOM 整崩。
 *
 * 修复：A1 32MB -> 8MB。正常代码 review 不会看 8MB 以上的单文件 diff，
 * 超限文件会走 diff-too-large 分支被跳过/提示，不再全量入内存。
 * 不改 I1 的 64MB 总量上限（j1）、cat-file 的 5MB（k1）、turn-diff 的 1MB。
 *
 * 兼容旧版 5MB/32MB/64MB 连续声明及新版 diff 包装器内联常量。
 * 新版通过 maxOutputBytes 输入、Math.min 和输出参数的 AST 关联定位，
 * 同时修改默认值与硬上限，保留调用方更小的限额。写入前 acorn 校验。
 *
 * Usage:
 *   node scripts/patch-diff-limits.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-diff-limits.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBuildTargets, relPath } = require("./patch-util");

const FIVE_MB = 5 * 1024 * 1024;
const OLD_DIFF_LIMIT = 32 * 1024 * 1024;
const NEW_DIFF_LIMIT = 8 * 1024 * 1024;
const TOTAL_DIFF_LIMIT = 64 * 1024 * 1024;
const NEW_DIFF_LIMIT_SOURCE = "8*1024*1024";

function parseCode(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  }
}

function staticNumber(node) {
  if (node?.type === "Literal" && typeof node.value === "number") return node.value;
  if (node?.type !== "BinaryExpression") return null;
  const left = staticNumber(node.left);
  const right = staticNumber(node.right);
  if (left == null || right == null) return null;
  if (node.operator === "*") return left * right;
  if (node.operator === "+") return left + right;
  return null;
}

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visitor));
    else if (value?.type) walk(value, visitor);
  }
}

function findLimitSequences(ast) {
  const matches = [];
  walk(ast, (node) => {
    if (node.type !== "VariableDeclaration") return;
    for (let index = 0; index <= node.declarations.length - 3; index++) {
      const group = node.declarations.slice(index, index + 3);
      const values = group.map((declaration) => staticNumber(declaration.init));
      if (
        values[0] === FIVE_MB &&
        [OLD_DIFF_LIMIT, NEW_DIFF_LIMIT].includes(values[1]) &&
        values[2] === TOTAL_DIFF_LIMIT
      ) {
        matches.push({ declaration: group[1], value: values[1] });
      }
    }
  });
  return matches;
}

function propertyName(node) {
  return node?.type === "Property" ? node.key.name ?? node.key.value : null;
}

function findInlineLimits(ast, source) {
  const matches = new Map();
  walk(ast, (fn) => {
    if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(fn.type)) return;
    if (!source.slice(fn.start, fn.end).includes("--binary")) return;
    const inputNames = new Set();
    walk(fn.body, (node) => {
      if (node.type !== "ObjectPattern") return;
      const keys = node.properties.map(propertyName);
      if (!keys.includes("binary") || !keys.includes("configOverrides")) return;
      const input = node.properties.find((prop) => propertyName(prop) === "maxOutputBytes")?.value;
      if (input?.type === "Identifier") inputNames.add(input.name);
    });
    walk(fn.body, (node) => {
      if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return;
      const conditional = node.init;
      if (conditional?.type !== "ConditionalExpression") return;
      const { test, consequent, alternate } = conditional;
      if (test.type !== "BinaryExpression" || test.operator !== "==") return;
      const input = test.left.type === "Literal" && test.left.value === null ? test.right :
        test.right.type === "Literal" && test.right.value === null ? test.left : null;
      if (input?.type !== "Identifier" || !inputNames.has(input.name)) return;
      if (alternate.type !== "CallExpression" || alternate.callee?.type !== "MemberExpression" ||
        alternate.callee.object?.name !== "Math" || alternate.callee.property?.name !== "min" ||
        alternate.arguments.length !== 2 || alternate.arguments[0].name !== input.name) return;
      const nodes = [consequent, alternate.arguments[1]];
      const values = nodes.map(staticNumber);
      if (!values.every((value) => [OLD_DIFF_LIMIT, NEW_DIFF_LIMIT].includes(value))) return;
      let forwarded = false;
      walk(fn.body, (prop) => {
        if (propertyName(prop) === "maxOutputBytes" && prop.value?.type === "Identifier" &&
          prop.value.name === node.id.name) forwarded = true;
      });
      if (forwarded) matches.set(node.start, { nodes, values });
    });
  });
  return [...matches.values()];
}

function patchSource(source) {
  let ast;
  try {
    ast = parseCode(source);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  const legacy = findLimitSequences(ast).map(({ declaration, value }) => ({
    nodes: [declaration.init], values: [value],
  }));
  const matches = [...legacy, ...findInlineLimits(ast, source)];
  if (matches.length !== 1) {
    return { status: "unexpected-anchor-count", count: matches.length, source };
  }
  if (matches[0].values.every((value) => value === NEW_DIFF_LIMIT)) {
    return { status: "already-patched", source };
  }

  let next = source;
  for (const init of [...matches[0].nodes].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, init.start) + NEW_DIFF_LIMIT_SOURCE + next.slice(init.end);
  }
  try {
    parseCode(next);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }
  return { status: "patched", source: next };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateBuildTargets({
    platform,
    label: "Git diff output limit",
    test: (source) => source.includes("diff-too-large") && source.includes("--no-ext-diff") &&
      source.includes("maxOutputBytes"),
  });

  let patched = 0;
  let failed = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    const result = patchSource(code);
    const label = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }
    if (result.status === "unexpected-anchor-count") {
      console.log(`  [x] ${label}: expected exactly 1 diff limit sequence, found ${result.count}`);
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: parse validation failed (${result.error.message})`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [?] ${label}: would tighten diff output limit 32MB -> 8MB`);
    } else {
      fs.writeFileSync(bundle.path, result.source);
      console.log(`  [ok] ${label}: diff output limit tightened 32MB -> 8MB`);
    }
    patched++;
  }

  console.log(`  [done] ${isCheck ? "would patch" : "patched"} ${patched} file(s)`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { NEW_DIFF_LIMIT_SOURCE, findLimitSequences, patchSource };

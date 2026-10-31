#!/usr/bin/env node
/**
 * patch-worker-limits.js — 给主进程 git/diff worker 线程加 V8 堆上限（保命线）
 *
 * 背景：2026-07-04 22:22 崩溃取证（V3 主进程采样 + V2 worker 采样）实锤：
 * worker-manager 创建的 worker.js 线程在执行任务时 V8 堆从 52MB 暴涨到
 * 2.8GB（large_object_space 破 1GB，即巨型字符串/数组），把整个主进程
 * commit 顶到 3GB+，最终 chrome.dll 在 native 分配失败后写空指针整崩。
 *
 * worker_threads 默认不限制堆大小，失控任务会拖死整个应用。本补丁在
 * new Worker(...) 处加 resourceLimits：
 *   - maxOldGenerationSizeMb: 1024 —— 老生代上限 1GB。正常观测基线为
 *     52MB、任务高峰几百 MB，1GB 足够正常任务；失控时 worker 以
 *     ERR_WORKER_OUT_OF_MEMORY 终止，业务侧 worker-manager 已有
 *     error/exit 监听与懒重建逻辑（ensureWorker），应用本体不受影响。
 *   - maxYoungGenerationSizeMb: 128 —— 新生代宽松上限。
 *
 * 2026-07-04 22:49 复崩后从 1536 降到 1024：当时 worker 堆到 1189MB
 * 时进程先因 V8 共享指针压缩 cage（同进程全部 isolate 共享 4GB 保留
 * 地址空间）分配失败而主动 OOM crash，1536 的优雅上限来不及触发。
 * resourceLimits 只在 GC 检查点核对，必须显著低于 cage 崩溃线才有
 * 机会先优雅 OOM；1024 仍是正常基线（52MB）的 20 倍。
 *
 * 只动 worker-manager 的构造点，child-process-snapshot 等短命 worker 不动。
 * 新版 Git worker 使用 utilityProcess.fork，通过 Chromium 的 --js-flags 设置 1GB 老生代上限。
 * 直接传 Node 的 --max-old-space-size 不生效，必须使用 Electron 的参数入口。
 *
 * 幂等：线程和独立进程两处均有已知上限时跳过；未知上限报错。写入前 acorn 校验。
 *
 * Usage:
 *   node scripts/patch-worker-limits.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-worker-limits.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBuildTargets, relPath } = require("./patch-util");

const LIMITS = "resourceLimits:{maxOldGenerationSizeMb:1024,maxYoungGenerationSizeMb:128}";
const UTILITY_HEAP_FLAG = "--js-flags=--max-old-space-size=1024";
// 已注入的旧上限（用于降级/升级替换）
const STALE_LIMITS = [
  "resourceLimits:{maxOldGenerationSizeMb:1536,maxYoungGenerationSizeMb:128}",
];

function parseCode(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  }
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

function propertyName(property) {
  if (!property || property.type !== "Property") return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return property.key.value;
  return null;
}

function isManagerWorkerOptions(options) {
  if (options?.type !== "ObjectExpression") return false;
  const name = options.properties.find((property) => propertyName(property) === "name");
  const workerData = options.properties.find(
    (property) => propertyName(property) === "workerData",
  );
  return (
    workerData != null &&
    name?.value?.type === "MemberExpression" &&
    name.value.object?.type === "ThisExpression" &&
    name.value.property?.type === "Identifier" &&
    name.value.property.name === "id"
  );
}

function findManagerWorkerOptions(ast) {
  const matches = [];
  walk(ast, (node) => {
    if (
      node.type !== "NewExpression" ||
      node.callee?.type !== "MemberExpression" ||
      node.callee.property?.type !== "Identifier" ||
      node.callee.property.name !== "Worker"
    ) {
      return;
    }
    const options = node.arguments?.[1];
    if (isManagerWorkerOptions(options)) matches.push(options);
  });
  return matches;
}

function findGitUtilityOptions(ast) {
  const matches = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || node.callee?.property?.name !== "fork" ||
      node.callee.object?.property?.name !== "utilityProcess") return;
    const options = node.arguments[2];
    if (options?.type !== "ObjectExpression") return;
    const service = options.properties.find((prop) => propertyName(prop) === "serviceName")?.value;
    const name = service?.type === "Literal" ? service.value :
      service?.type === "TemplateLiteral" && service.expressions.length === 0 ? service.quasis[0].value.cooked : null;
    if (name === "Git worker") matches.push(options);
  });
  return matches;
}

function patchSource(source) {
  let code = source;
  let upgraded = false;
  for (const stale of STALE_LIMITS) {
    if (!code.includes(stale)) continue;
    code = code.split(stale).join(LIMITS);
    upgraded = true;
  }

  let ast;
  try {
    ast = parseCode(code);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  const matches = findManagerWorkerOptions(ast);
  if (matches.length !== 1) {
    return { status: "unexpected-anchor-count", count: matches.length, source };
  }

  const options = matches[0];
  const edits = [];
  const existing = options.properties.find(
    (property) => propertyName(property) === "resourceLimits",
  );
  if (existing) {
    if (code.slice(existing.start, existing.end) !== LIMITS) {
      return { status: "unexpected-existing-limits", source };
    }
  } else {
    edits.push({ start: options.end - 1, end: options.end - 1,
      replacement: `${options.properties.length > 0 ? "," : ""}${LIMITS}` });
  }

  const utilities = findGitUtilityOptions(ast);
  if (utilities.length > 1) return { status: "unexpected-anchor-count", count: utilities.length, source };
  for (const utility of utilities) {
    const argv = utility.properties.find((prop) => propertyName(prop) === "execArgv");
    if (!argv) {
      edits.push({ start: utility.end - 1, end: utility.end - 1,
        replacement: `,execArgv:[${JSON.stringify(UTILITY_HEAP_FLAG)}]` });
    } else {
      const elements = argv.value?.type === "ArrayExpression" ? argv.value.elements : null;
      if (!elements || elements.some((element) => element?.type !== "Literal" || typeof element.value !== "string")) {
        return { status: "unexpected-existing-limits", source };
      }
      const heapFlags = elements.filter((element) => /^--(?:js-flags|max[-_]old[-_]space[-_]size)/.test(element.value));
      if (heapFlags.length > 1 || (heapFlags.length === 1 && heapFlags[0].value !== UTILITY_HEAP_FLAG)) {
        return { status: "unexpected-existing-limits", source };
      }
      if (heapFlags.length === 0) edits.push({ start: argv.value.end - 1, end: argv.value.end - 1,
        replacement: `${elements.length ? "," : ""}${JSON.stringify(UTILITY_HEAP_FLAG)}` });
    }
  }
  if (edits.length === 0 && !upgraded) return { status: "already-patched", source };
  let next = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
  }
  try {
    parseCode(next);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }
  return { status: "patched", mode: upgraded ? "upgraded" : "added", source: next };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateBuildTargets({
    platform,
    label: "Worker resource limits",
    test: (source) => source.includes("ensureWorker") && source.includes("workerData"),
  });

  if (bundles.length === 0) {
    throw new Error("Worker manager bundle not found");
  }

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
      console.log(`  [x] ${label}: expected exactly 1 worker ctor anchor, found ${result.count}`);
      failed++;
      continue;
    }
    if (result.status === "unexpected-existing-limits") {
      console.log(`  [x] ${label}: worker already has unknown resourceLimits`);
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: parse validation failed (${result.error.message})`);
      failed++;
      continue;
    }

    const action = result.mode === "upgraded" ? "upgrade" : "add";
    if (isCheck) {
      console.log(`  [?] ${label}: would ${action} worker resourceLimits (old-gen 1024MB)`);
    } else {
      fs.writeFileSync(bundle.path, result.source);
      console.log(`  [ok] ${label}: worker resourceLimits ${action === "add" ? "added" : "upgraded"}`);
    }
    patched++;
  }

  console.log(`  [done] ${isCheck ? "would patch" : "patched"} ${patched} file(s)`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { LIMITS, UTILITY_HEAP_FLAG, findManagerWorkerOptions, patchSource };

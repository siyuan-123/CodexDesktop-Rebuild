#!/usr/bin/env node
/**
 * patch-cdp-screenshot.js — 驯服 browser-use 的 CDP 全页截图，防主进程内存风暴
 *
 * 背景：崩溃取证（minidump + 内存采样）证实主进程崩溃源于 native 内存压力：
 * RSS 周期性冲到 3GB+，崩溃瞬间 commit 2.6GB、最大单块 634MB，chrome.dll 内部
 * 分配失败后近空指针读写（两次 dump 位置漂移：读 0x2 / 写 0x0）。
 *
 * 元凶是 agent browser-use 的 CDP 截图管线：`Page.captureScreenshot` 带
 * `captureBeyondViewport:true` + 整页 clip + PNG——整页光栅化位图 → PNG 编码
 * → base64 经 CDP JSON 回传主进程 → 解码副本，单次几百 MB，agent 每步操作
 * 都截一张。
 *
 * 修复：在主进程 CDP 统一转发点（sendDebuggerCommand → debugger.sendCommand）
 * 注入参数守卫，仅拦截 captureBeyondViewport===true 的整页截图请求：
 *   1. captureBeyondViewport → false，删除整页 clip（只截可视区，
 *      OpenAI/Anthropic 官方 computer-use 均为视口截图，agent 可滚动后再截）
 *   2. format 未指定或为 png 时改为 jpeg quality=60（buffer 与 base64 体积
 *      缩一个数量级）
 * 视口/小区域截图（annotation、comment、剪贴板等）不受任何影响。
 *
 * 上游 waitForCaptureSurface 仍按原始参数等待整页 surface，等不到时 1 秒
 * (TJ=1e3) 超时后照常继续，功能无损，最坏多 1 秒延迟。
 *
 * 写入前用 acorn 对整份文件做语法校验，解析失败则中止不写。
 *
 * Usage:
 *   node scripts/patch-cdp-screenshot.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-cdp-screenshot.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBuildTargets, relPath } = require("./patch-util");

const MARKER = "__codexCdpGuard";

// 守卫函数：挂在 globalThis 上，避免与压缩后的模块作用域变量冲突。
// 只动整页截图请求，其余参数原样透传；任何异常都回退为原参数。
const GUARD_DEF =
  ";globalThis." +
  MARKER +
  "=function(m,p){try{if(m===`Page.captureScreenshot`&&p&&typeof p==`object`&&p.captureBeyondViewport===!0){var q={};for(var k in p)q[k]=p[k];q.captureBeyondViewport=!1;delete q.clip;(q.format==null||q.format===`png`)&&(q.format=`jpeg`,q.quality=60);return q}}catch(e){}return p};\n";

// CDP 统一转发点（sendDebuggerCommand 内部），不依赖所在 chunk 的文件名。
const ANCHOR =
  "return await hY(e.webContents.debugger.sendCommand(t,n,i),this.cdpCommandTimeoutMs,";
const REPLACEMENT =
  "return await hY(e.webContents.debugger.sendCommand(t,globalThis." +
  MARKER +
  "(t,n),i),this.cdpCommandTimeoutMs,";
const DYNAMIC_ANCHOR_RE =
  /return await ([A-Z_$a-z][\w$]*)\(([A-Z_$a-z][\w$]*)\.webContents\.debugger\.sendCommand\(([A-Z_$a-z][\w$]*),([A-Z_$a-z][\w$]*),([A-Z_$a-z][\w$]*)\),(this\.cdpCommandTimeoutMs|[A-Z_$a-z][\w$]*),/;

function parseOk(code) {
  try {
    acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
    return true;
  } catch {
    try {
      acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
      return true;
    } catch {
      return false;
    }
  }
}

function walk(node, visit) {
  if (!node?.type) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function patchDebuggerCommand(code) {
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" }); } catch { return null; }
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression" ||
      node.callee.property?.name !== "sendCommand" || node.arguments.length < 2) return;
    const calleeSource = code.slice(node.callee.start, node.callee.end);
    const methodArg = node.arguments[0];
    const params = node.arguments[1];
    // 统一浏览器转发点的参数是 (method, params, sessionId)。
    // 其他 CDP 调用多以字符串 + 对象字面量出现，避免误包裹。
    if (!calleeSource.includes("webContents.debugger") ||
      methodArg.type !== "Identifier" || params.type !== "Identifier") return;
    const method = code.slice(methodArg.start, methodArg.end);
    patches.push({ start: params.start, end: params.end, replacement: `globalThis.${MARKER}(${method},${code.slice(params.start, params.end)})` });
  });
  if (patches.length !== 1) return null;
  const patch = patches[0];
  return code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
}

function patchSource(code) {
  if (code.includes(MARKER)) {
    return { status: "already-patched", source: code };
  }

  let forwarded = null;
  if (code.includes(ANCHOR)) {
    forwarded = code.replace(ANCHOR, REPLACEMENT);
  } else {
    forwarded = code.replace(
      DYNAMIC_ANCHOR_RE,
      (match, timeoutFn, webContents, method, params, sessionId, timeout) =>
        `return await ${timeoutFn}(${webContents}.webContents.debugger.sendCommand(` +
        `${method},globalThis.${MARKER}(${method},${params}),${sessionId}),${timeout},`,
    );
    if (forwarded === code) forwarded = null;
  }

  if (forwarded == null) forwarded = patchDebuggerCommand(code);

  if (forwarded == null) {
    const hasBrowserScreenshotPipeline =
      code.includes("Page.captureScreenshot") &&
      code.includes("captureBeyondViewport") &&
      code.includes("sendDebuggerCommand");
    return {
      status: hasBrowserScreenshotPipeline ? "unexpected-shape" : "not-applicable",
      source: code,
    };
  }

  const next = GUARD_DEF + forwarded;
  if (!parseOk(next)) {
    return { status: "invalid-output", source: code };
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
    label: "CDP screenshot guard",
    test: (source) => source.includes("sendDebuggerCommand") &&
      source.includes("captureBeyondViewport"),
  });

  if (bundles.length === 0) {
    throw new Error("CDP screenshot pipeline not found");
  }

  let patched = 0;
  let failed = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    const result = patchSource(code);
    if (result.status === "already-patched") {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      continue;
    }
    if (result.status === "not-applicable") {
      console.log(`  [--] ${relPath(bundle.path)}: no CDP screenshot pipeline`);
      continue;
    }
    if (result.status === "unexpected-shape") {
      console.log(
        `  [x] ${relPath(bundle.path)}: CDP screenshot pipeline found but forward anchor changed`,
      );
      failed++;
      continue;
    }
    if (result.status === "invalid-output") {
      console.log(
        `  [x] ${relPath(bundle.path)}: post-inject parse failed, aborting`,
      );
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would patch CDP screenshot guard`,
      );
      continue;
    }

    fs.writeFileSync(bundle.path, result.source);
    console.log(
      `  [ok] ${relPath(bundle.path)}: CDP fullpage screenshot -> viewport jpeg q60`,
    );
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { DYNAMIC_ANCHOR_RE, GUARD_DEF, MARKER, patchSource };

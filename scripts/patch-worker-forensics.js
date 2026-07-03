#!/usr/bin/env node
/**
 * patch-worker-forensics.js — app-server / worker 进程未捕获异常落盘取证
 *
 * 背景：审查发现 worker.js（Node 子进程 / app-server）里 Sentry 的
 * OnUncaughtException 集成配置为 exitEvenIfOtherHandlersAreRegistered:false，
 * 该进程一旦抛出未捕获异常且无其他 handler，就会 process.exit(1) 静默退出。
 * 这是“进程直接没了”的另一条可能路径（JS 层，区别于主进程 native 崩溃）。
 *
 * 主进程的 crash-forensics 只覆盖 browser 进程；worker 退出虽会触发主进程
 * child-process-gone（已落盘），但拿不到 worker 内部的 JS 异常栈。本补丁向
 * worker.js 顶部注入一段取证钩子，在 worker 抛异常时把栈落盘到同一
 * CodexForensics 目录。
 *
 * 关键：用 process.on("uncaughtExceptionMonitor", ...) 而非 "uncaughtException"。
 * 前者是 Node 专为“只观测”设计的事件——监听器执行后，原有的 uncaughtException
 * 处理（含 Sentry 的 handler 与退出决策）照常进行，绝不改变行为。unhandledRejection
 * 同样只记录不干预。
 *
 * 全部逻辑包在 try/catch 内，任何失败都不影响 worker 本身。
 * 写入前用 acorn 校验，解析失败则中止不写。
 *
 * Usage:
 *   node scripts/patch-worker-forensics.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-worker-forensics.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const MARKER = "__CODEX_WORKER_FORENSICS__";

// 注入体：自包含 CJS，不依赖 electron（worker/utility 进程无 app）。
function __codexWorkerForensics() {
  try {
    var fs = require("node:fs");
    var path = require("node:path");
    var os = require("node:os");
    var baseDir =
      process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
    var dir = path.join(baseDir, "CodexForensics");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
    var logFile = path.join(
      dir,
      "forensics-" + new Date().toISOString().slice(0, 10) + ".log",
    );

    // 标注进程角色：worker_threads 主线程 / 工作线程 / 独立进程
    var role = "worker";
    try {
      var wt = require("node:worker_threads");
      role = wt.isMainThread ? "worker-main" : "worker-thread#" + wt.threadId;
    } catch (e) {}

    function write(line) {
      try {
        fs.appendFileSync(
          logFile,
          "[" +
            new Date().toISOString() +
            "] [" +
            role +
            " pid=" +
            process.pid +
            "] " +
            line +
            "\n",
        );
      } catch (e) {}
    }

    write("worker boot argv=" + JSON.stringify(process.argv.slice(1)));

    // uncaughtExceptionMonitor：只观测，不改变默认/Sentry 退出决策
    process.on("uncaughtExceptionMonitor", function (err) {
      write(
        "WORKER uncaughtException: " +
          (err && err.stack ? err.stack : String(err)),
      );
    });
    // unhandledRejection：只记录，不干预
    process.on("unhandledRejection", function (reason) {
      write(
        "WORKER unhandledRejection: " +
          (reason && reason.stack ? reason.stack : String(reason)),
      );
    });
  } catch (e) {
    try {
      require("node:fs").appendFileSync(
        require("node:path").join(
          require("node:os").tmpdir(),
          "codex-forensics-fatal.log",
        ),
        "worker-forensics: " + String((e && e.stack) || e) + "\n",
      );
    } catch (e2) {}
  }
}

const INJECT =
  "/*" + MARKER + "*/;(" + __codexWorkerForensics.toString() + ")();\n";

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

// 确认是运行 Sentry OnUncaughtException 的 worker（避免误注入其它同名文件）
function isSentryWorker(code) {
  return (
    code.includes("worker_threads") &&
    code.includes("we are exiting the process now")
  );
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateBundles({
    dir: "build",
    pattern: /^worker\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.log("  [skip] worker.js not found");
    return;
  }

  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes(MARKER)) {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      continue;
    }

    if (!isSentryWorker(code)) {
      console.log(
        `  [!] ${relPath(bundle.path)}: not the Sentry worker, skipping`,
      );
      continue;
    }

    const next = INJECT + code;

    if (!parseOk(next)) {
      console.log(
        `  [x] ${relPath(bundle.path)}: post-inject parse failed, aborting`,
      );
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would inject worker forensics (+${INJECT.length} bytes)`,
      );
      continue;
    }

    fs.writeFileSync(bundle.path, next);
    console.log(`  [ok] ${relPath(bundle.path)}: injected worker forensics`);
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
}

main();

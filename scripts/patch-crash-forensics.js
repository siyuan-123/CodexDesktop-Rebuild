#!/usr/bin/env node
/**
 * patch-crash-forensics.js — 主进程崩溃取证注入
 *
 * 背景：已从 minidump 定位到崩溃发生在“主进程(browser/UI 线程)”，类型为
 * ACCESS_VIOLATION 读地址 0x2，RIP 落在 chrome.dll。现有 crashpad dump 为精简版
 * (仅崩溃线程、无符号)，无法进一步定位。本补丁向主进程入口 bootstrap.js 最前端
 * 注入一段“只观测、不改行为”的取证代码，用于在下一次崩溃前后落盘可分析的证据：
 *
 *   1. Chromium 原生日志落盘 (--enable-logging=file / --log-file)，可捕获崩溃前
 *      chrome.dll 的 CHECK/DCHECK/GPU 等错误。
 *   2. child-process-gone / render-process-gone / GPU 崩溃 事件结构化落盘。
 *   3. 主进程 uncaughtException / unhandledRejection 落盘，并尽量保留默认退出语义。
 *   4. 每 30s 采样 process.memoryUsage() + app.getAppMetrics()，判断是否内存泄漏/OOM。
 *   5. 记录启动进程信息与已加载的可疑原生模块 (computer-use / device-kit / pty / sqlite)。
 *
 * 全部逻辑包在 try/catch 内，任何失败都不会影响应用本身。
 *
 * 注入方式：把一个“真实 JS 函数”序列化成 IIFE 预置到 bootstrap.js 顶部，
 * 写入前用 acorn 对整份文件做语法校验，解析失败则中止不写。
 *
 * Usage:
 *   node scripts/patch-crash-forensics.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-crash-forensics.js --check       # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const LEGACY_MARKER = "__CODEX_CRASH_FORENSICS__";
const MARKER = "__CODEX_CRASH_FORENSICS_V2__";

// ──────────────────────────────────────────────
//  注入体：以真实函数形式书写，保证语法正确。
//  运行在 bootstrap.js 的 CommonJS 作用域内 (可用 require)。
//  注意：不得依赖任何压缩后的外部变量名，全部自包含。
// ──────────────────────────────────────────────
function __codexForensics() {
  try {
    var electron = require("electron");
    var app = electron.app;
    var fs = require("node:fs");
    var path = require("node:path");
    var os = require("node:os");

    // 取证输出目录：优先 LOCALAPPDATA/APPDATA，最后回退临时目录。
    // 该目录在 app ready 之前即可确定，便于给 Chromium 的 --log-file 使用。
    var baseDir =
      process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
    var earlyDir = path.join(baseDir, "CodexForensics");
    try {
      fs.mkdirSync(earlyDir, { recursive: true });
    } catch (e) {}

    var logFile = path.join(
      earlyDir,
      "forensics-" + new Date().toISOString().slice(0, 10) + ".log",
    );
    var chromeLog = path.join(earlyDir, "chrome-debug.log");

    function write(line) {
      try {
        fs.appendFileSync(
          logFile,
          "[" + new Date().toISOString() + "] " + line + "\n",
        );
      } catch (e) {}
    }

    // 1) 打开 Chromium 原生日志到文件 (必须在 app ready 之前设置)
    try {
      app.commandLine.appendSwitch("enable-logging", "file");
      app.commandLine.appendSwitch("log-file", chromeLog);
      app.commandLine.appendSwitch("log-level", "1");
    } catch (e) {
      write("appendSwitch failed: " + (e && e.message));
    }

    write(
      "=== forensics boot pid=" +
        process.pid +
        " ppid=" +
        process.ppid +
        " node=" +
        process.versions.node +
        " electron=" +
        process.versions.electron +
        " chrome=" +
        process.versions.chrome +
        " platform=" +
        process.platform +
        " arch=" +
        process.arch +
        " argv=" +
        JSON.stringify(process.argv.slice(1)) +
        " ===",
    );

    // 2) 主进程未捕获异常 / 未处理 Promise 拒绝。
    // uncaughtExceptionMonitor 只观察，不改变 Node 默认退出行为。
    process.on("uncaughtExceptionMonitor", function (err) {
      write(
        "MAIN uncaughtExceptionMonitor: " +
          (err && err.stack ? err.stack : String(err)),
      );
    });

    // unhandledRejection 没有 monitor 事件；如果没有其他业务监听器，记录后
    // 重新抛出，让 Node/Electron 维持“未处理拒绝为致命错误”的默认行为。
    // 如果业务代码已有监听器，默认行为本来已经被业务代码接管，这里只记录。
    process.on("unhandledRejection", function (reason) {
      write(
        "MAIN unhandledRejection: " +
          (reason && reason.stack ? reason.stack : String(reason)),
      );
      try {
        if (process.listenerCount("unhandledRejection") === 1) {
          setImmediate(function () {
            throw reason instanceof Error
              ? reason
              : new Error("Unhandled rejection: " + String(reason));
          });
        }
      } catch (e) {}
    });

    // 记录已加载的可疑原生模块 (.node)
    function dumpNativeModules(tag) {
      try {
        var loaded = Object.keys(require.cache || {}).filter(function (k) {
          return /\.node$/i.test(k);
        });
        var hot = loaded.filter(function (k) {
          return /computer-use|device-kit|wl-device|node-hid|serialport|node-pty|conpty|better.?sqlite|canvas|sharp|tesseract/i.test(
            k,
          );
        });
        write(
          tag +
            " native_modules total=" +
            loaded.length +
            " suspects=" +
            JSON.stringify(hot),
        );
      } catch (e) {}
    }

    function onReady() {
      try {
        write(
          "app ready userData=" +
            (function () {
              try {
                return app.getPath("userData");
              } catch (e) {
                return "?";
              }
            })() +
            " version=" +
            (function () {
              try {
                return app.getVersion();
              } catch (e) {
                return "?";
              }
            })(),
        );
        dumpNativeModules("at-ready");

        // 3) 子进程 / 渲染进程 / GPU 崩溃落盘
        app.on("child-process-gone", function (_e, details) {
          write("child-process-gone " + JSON.stringify(details));
        });
        app.on("render-process-gone", function (_e, _wc, details) {
          write("render-process-gone " + JSON.stringify(details));
        });
        try {
          app.on("gpu-process-crashed", function (_e, killed) {
            write("gpu-process-crashed killed=" + killed);
          });
        } catch (e) {}
      } catch (e) {
        write("onReady failed: " + (e && e.message));
      }
    }
    try {
      if (app.isReady && app.isReady()) onReady();
      else app.once("ready", onReady);
    } catch (e) {}

    // 4) 内存采样：每 30s 记录主进程与各子进程内存，判断泄漏/OOM 趋势
    //    附带水位保护：主进程 RSS 超过 4GB 时清 HTTP/代码缓存并记录（5 分钟限频）。
    //    清缓存对巨型截图 buffer 无直接作用，但可释放部分压力并留下水位事件证据。
    var WATERLINE_BYTES = 4 * 1024 * 1024 * 1024;
    var PURGE_COOLDOWN_MS = 5 * 60 * 1000;
    var lastPurge = 0;
    var sample = 0;
    var timer = setInterval(function () {
      try {
        var mu = process.memoryUsage();
        var procs = [];
        try {
          procs = app.getAppMetrics().map(function (m) {
            return {
              pid: m.pid,
              type: m.type,
              wsMB: Math.round(
                ((m.memory && m.memory.workingSetSize) || 0) / 1024,
              ),
            };
          });
        } catch (e) {}
        write(
          "mem#" +
            ++sample +
            " main_rssMB=" +
            Math.round(mu.rss / 1048576) +
            " heapUsedMB=" +
            Math.round(mu.heapUsed / 1048576) +
            " externalMB=" +
            Math.round((mu.external || 0) / 1048576) +
            " procs=" +
            JSON.stringify(procs),
        );

        if (
          mu.rss > WATERLINE_BYTES &&
          Date.now() - lastPurge > PURGE_COOLDOWN_MS
        ) {
          lastPurge = Date.now();
          write(
            "WATERLINE main_rssMB=" +
              Math.round(mu.rss / 1048576) +
              " exceeds 4096MB, purging session caches",
          );
          try {
            var ses = electron.session && electron.session.defaultSession;
            if (ses) {
              ses.clearCache().then(
                function () {
                  write("WATERLINE clearCache done");
                },
                function (e) {
                  write("WATERLINE clearCache failed: " + (e && e.message));
                },
              );
              if (ses.clearCodeCaches) {
                ses.clearCodeCaches({}).catch(function () {});
              }
            }
          } catch (e) {
            write("WATERLINE purge error: " + (e && e.message));
          }
        }
      } catch (e) {}
    }, 30000);
    try {
      timer.unref && timer.unref();
    } catch (e) {}
  } catch (err) {
    // 取证代码自身绝不能拖垮应用
    try {
      require("node:fs").appendFileSync(
        require("node:path").join(
          require("node:os").tmpdir(),
          "codex-forensics-fatal.log",
        ),
        String((err && err.stack) || err) + "\n",
      );
    } catch (e) {}
  }
}

const INJECT =
  "/*" + MARKER + "*/;(" + __codexForensics.toString() + ")();\n";

function startsWithForensicsInjection(code) {
  const trimmed = code.trimStart();
  return (
    trimmed.startsWith("/*" + MARKER + "*/;(") ||
    trimmed.startsWith("/*" + LEGACY_MARKER + "*/;(") ||
    trimmed.startsWith("(function __codexForensics()")
  );
}

function stripLeadingForensicsInjection(code) {
  if (!startsWithForensicsInjection(code)) {
    return { code, stripped: false };
  }

  try {
    const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
    const first = ast.body && ast.body.find((node) => node.type !== "EmptyStatement");
    if (!first || first.end == null) return { code, stripped: false };
    return {
      code: code.slice(first.end).replace(/^\s*\n?/, ""),
      stripped: true,
    };
  } catch {
    return { code, stripped: false };
  }
}

function stripKnownInjections(code) {
  let next = code;
  let stripped = false;

  while (true) {
    const before = next;
    const result = stripLeadingForensicsInjection(next);
    next = result.code;
    stripped = stripped || result.stripped;

    if (next === before) break;
  }

  return { code: next, stripped };
}

function isElectronBootstrap(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return false;
  }
  let found = false;
  (function walk(node) {
    if (!node || typeof node !== "object" || found) return;
    if (
      node.type === "CallExpression" &&
      node.callee &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      const arg = node.arguments && node.arguments[0];
      const val =
        arg && arg.type === "Literal"
          ? arg.value
          : arg &&
              arg.type === "TemplateLiteral" &&
              arg.quasis.length === 1 &&
              arg.expressions.length === 0
            ? arg.quasis[0].value.cooked
            : null;
      if (val === "electron") found = true;
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && v.type) walk(v);
    }
  })(ast);
  return found;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateBundles({
    dir: "build",
    pattern: /^bootstrap\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.log("  [skip] bootstrap.js not found");
    return;
  }

  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes(MARKER)) {
      const afterCurrent = stripLeadingForensicsInjection(code).code;
      if (!startsWithForensicsInjection(afterCurrent)) {
        console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
        continue;
      }
    }

    const { code: baseCode, stripped } = stripKnownInjections(code);
    if (!isElectronBootstrap(baseCode)) {
      console.log(
        `  [!] ${relPath(bundle.path)}: not an electron bootstrap, skipping`,
      );
      continue;
    }

    const next = INJECT + baseCode;

    // 写入前对最终结果做语法校验，解析失败则中止不写
    try {
      acorn.parse(next, { ecmaVersion: 2022, sourceType: "script" });
    } catch (e) {
      console.log(
        `  [x] ${relPath(bundle.path)}: post-inject parse failed, aborting (${e.message})`,
      );
      continue;
    }

    if (isCheck) {
      console.log(`  [?] ${relPath(bundle.path)}: would inject forensics (+${INJECT.length} bytes)`);
      continue;
    }

    fs.writeFileSync(bundle.path, next);
    console.log(
      `  [ok] ${relPath(bundle.path)}: ${stripped ? "upgraded" : "injected"} crash forensics`,
    );
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
}

main();

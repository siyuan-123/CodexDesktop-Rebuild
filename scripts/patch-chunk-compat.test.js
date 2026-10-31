const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parse } = require("acorn");
const { patchSource: patchHome } = require("./patch-codex-home-env");
const { patchSource: patchDiff } = require("./patch-diff-limits");
const { patchSource: patchWorker, UTILITY_HEAP_FLAG } = require("./patch-worker-limits");
const { patchSource: patchCdp, GUARD_DEF, MARKER } = require("./patch-cdp-screenshot");
const { collectPatches: copyright } = require("./patch-copyright");
const { collectPatches: devtools } = require("./patch-devtools");
const { collectPatches: plugin } = require("./patch-plugin-auth");
const { collectPatches: updater } = require("./patch-updater");
const { hasNativeScopeProtection } = require("./patch-sentry-scope");

function apply(source, collect, ...args) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const patches = collect(ast, source, ...args).sort((a, b) => b.start - a.start);
  let next = source;
  for (const patch of patches) next = next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
  parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return { source: next, patches };
}

const diffSource = 'const unrelated=0x2000000;function diff(options={}){let{binary:b=!1,maxOutputBytes:m,configOverrides:c=[]}=options,l=null==m?0x2000000:Math.min(m,0x2000000);return execute(["diff","--no-ext-diff",...b?["--binary"]:[]],{configOverrides:c,maxOutputBytes:l})}';
const workerSource = 'class Manager{ensureWorker(){if(this.id==="git")return electron.utilityProcess.fork(file,[],{serviceName:"Git worker",stdio:"pipe"});return new thread.Worker(file,{name:this.id,workerData:data,transferList:ports})}}';
const cdpSource = 'class Browser{capture(e){return this.sendDebuggerCommand(e,"Page.captureScreenshot",{captureBeyondViewport:true})}async sendDebuggerCommand(e,t,r,n={},i=this.cdpCommandTimeoutMs){let s=n.sessionId;return normalize(t,await wait(e.webContents.debugger.sendCommand(t,r,s),i,"timeout"))}async metrics(e){return e.webContents.debugger.sendCommand("Page.getLayoutMetrics",{})}}';
const pluginSource = 'function moduleFactory(){const defaults={browserPane:!1,inAppBrowserUse:!1,externalBrowserUseAllowed:!1,computerUse:!1,unrelated:!1};function auth(){const allowed=config.shouldIncludeBrowserUsePeerAuthorization();if(!allowed)return()=>({authorized:!0});return native()}return {defaults,auth}}';

test("About HTML 兼容转义版权符号，修改后 HTML 与幂等性正确", () => {
  const source = 'const html=`<div class="copyright">\\xa9 OpenAI</div>`;';
  const result = apply(source, copyright);
  assert.equal(vm.runInNewContext(`${result.source};html`), '<div class="copyright">© OpenAI · Cometix Space</div>');
  assert.equal(apply(result.source, copyright).patches.length, 0);
});

test("DevTools 放行窗口配置，保留解构参数及无关选项", () => {
  const source = 'function options({allowInspectElement:inspect}){return {allowInspectElement:inspect,devTools:policy.allowDevtools,sandbox:true}}';
  const result = apply(source, devtools);
  const config = vm.runInNewContext(`${result.source};options({allowInspectElement:false})`, { policy: { allowDevtools: false } });
  assert.equal(config.allowInspectElement, true);
  assert.equal(config.devTools, true);
  assert.equal(config.sandbox, true);
  assert.equal(apply(result.source, devtools).patches.length, 0);
});

for (const prefix of ['function boot', 'const boot=function', 'const boot=']) {
  test(`CODEX_HOME 在子进程启动前设置且保留已有值：${prefix}`, () => {
    const arrow = prefix === 'const boot=' ? '=>' : '';
    const source = `${prefix}({codexHome:h=resolveHome(),startServer:s=start})${arrow}{return s(h)};`;
    const result = patchHome(source, "fixture");
    assert.equal(result.changed, true);
    for (const existing of [undefined, "custom-home"]) {
      const process = { env: existing ? { CODEX_HOME: existing } : {} };
      const value = vm.runInNewContext(`${result.source};boot({})`, {
        process, resolveHome: () => "resolved-home", start: () => process.env.CODEX_HOME,
      });
      assert.equal(value, existing ?? "resolved-home");
    }
    assert.equal(patchHome(result.source).changed, false);
    assert.throws(() => patchHome(source + source.replaceAll('boot', 'other')), /Expected one/);
  });
}

test("内联 diff 上限同时覆盖默认值和硬上限，不影响更小限额与其他 32MB 常量", () => {
  const result = patchDiff(diffSource);
  assert.equal(result.status, "patched");
  const diff = vm.runInNewContext(`${result.source};diff`, { execute: (_args, options) => options });
  for (const input of [undefined, null, 1024, 0, 64 * 1024 * 1024]) {
    assert.equal(diff({ maxOutputBytes: input }).maxOutputBytes, input == null ? 8388608 : Math.min(input, 8388608));
  }
  assert.match(result.source, /unrelated=0x2000000/);
  assert.equal(patchDiff(result.source).status, "already-patched");
  assert.equal(patchDiff(diffSource + diffSource.replaceAll('diff', 'other').replaceAll('unrelated', 'otherConst')).status, "unexpected-anchor-count");
  assert.equal(patchDiff('function unrelated(m){return m==null?0x2000000:Math.min(m,0x2000000)}').status, "unexpected-anchor-count");
});

test("新版 Git utility worker 与线程 worker 都有内存上限且保留消息端口", () => {
  const result = patchWorker(workerSource);
  assert.equal(result.status, "patched");
  const ports = [{ id: 1 }];
  const context = {
    file: "worker.js", data: { id: 1 }, ports,
    electron: { utilityProcess: { fork: (_file, _args, options) => options } },
    thread: { Worker: function(_file, options) { return options; } },
  };
  const Manager = vm.runInNewContext(`${result.source};Manager`, context);
  const manager = new Manager();
  manager.id = "git";
  assert.equal(manager.ensureWorker().execArgv[0], UTILITY_HEAP_FLAG);
  assert.equal(manager.ensureWorker().stdio, "pipe");
  manager.id = "other";
  assert.equal(manager.ensureWorker().resourceLimits.maxOldGenerationSizeMb, 1024);
  assert.equal(manager.ensureWorker().transferList, ports);
  assert.equal(patchWorker(result.source).status, "already-patched");
  assert.equal(patchWorker(workerSource.replace('stdio:"pipe"', 'execArgv:["--max-old-space-size=4096"]')).status, "unexpected-existing-limits");
});

test("CDP 守卫兼容结果包装函数且保留 method、session 和响应处理", async () => {
  const result = patchCdp(cdpSource);
  assert.equal(result.status, "patched");
  const calls = [];
  const Browser = vm.runInNewContext(`${result.source};Browser`, {
    wait: async (value) => value, normalize: (method, value) => ({ method, value }),
  });
  const browser = new Browser();
  const input = { captureBeyondViewport: true, clip: { width: 20000 }, format: "png" };
  const target = { webContents: { debugger: { sendCommand: (...args) => { calls.push(args); return "image"; } } } };
  const output = await browser.sendDebuggerCommand(target, "Page.captureScreenshot", input, { sessionId: "session" });
  assert.equal(calls[0][0], "Page.captureScreenshot");
  assert.equal(calls[0][1].captureBeyondViewport, false);
  assert.equal(calls[0][1].clip, undefined);
  assert.equal(calls[0][1].format, "jpeg");
  assert.equal(calls[0][1].quality, 60);
  assert.equal(calls[0][2], "session");
  assert.equal(input.captureBeyondViewport, true);
  assert.equal(output.value, "image");
  assert.equal(output.method, "Page.captureScreenshot");
  assert.equal(patchCdp(result.source).status, "already-patched");
  const guard = vm.runInNewContext(`${GUARD_DEF};globalThis.${MARKER}`);
  const viewport = { clip: { width: 20 }, captureBeyondViewport: false };
  assert.equal(guard("Page.captureScreenshot", viewport), viewport);
  assert.equal(guard("Input.dispatchMouseEvent", input), input);
});

test("嵌套模块中的插件补丁不重复替换，正常解析且保持幂等", () => {
  const result = apply(pluginSource, plugin, ["features"]);
  assert.equal(result.patches.filter((patch) => patch.id === "peer_auth_bypass").length, 1);
  const value = vm.runInNewContext(`${result.source};moduleFactory()`, {
    config: { shouldIncludeBrowserUsePeerAuthorization: () => true }, native: () => { throw new Error("unexpected"); },
  });
  assert.equal(value.defaults.computerUse, true);
  assert.equal(value.defaults.unrelated, false);
  assert.equal(value.auth()().authorized, true);
  assert.equal(apply(result.source, plugin, ["features"]).patches.length, 0);
});

test("更新器兼容箭头函数且所有平台禁用，调用不再触发上游策略", () => {
  const source = 'const policy={shouldIncludeSparkle:()=>enabled(),shouldIncludeWindowsUpdater:()=>enabled(),shouldIncludeWindowsMsixUpdater:()=>enabled(),shouldIncludeLinuxPackageUpdater:()=>enabled(),shouldIncludeUpdater:()=>{return enabled()},unrelated:()=>true};';
  const result = apply(source, updater);
  const policy = vm.runInNewContext(`${result.source};policy`, { enabled: () => { throw new Error("unexpected"); } });
  for (const [name, fn] of Object.entries(policy)) assert.equal(fn(), name === "unrelated");
  assert.equal(apply(result.source, updater).patches.length, 0);
});

test("Sentry 原生保护兼容拆分 chunk，缺少任一保护条件不会被识别为完成", () => {
  const chunks = ['const marker="codex_truncated_breadcrumb_data";', 'init({beforeBreadcrumb:trim});const file="scope_v3.json",limit=2097152;'];
  assert.equal(hasNativeScopeProtection(chunks), true);
  for (const chunk of chunks) assert.equal(hasNativeScopeProtection(chunk), false);
});

test("拆分 chunk 的 CLI 补丁检查不写入，全部应用后可重复执行", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chunk-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = ['patch-copyright', 'patch-devtools', 'patch-codex-home-env', 'patch-diff-limits', 'patch-worker-limits', 'patch-cdp-screenshot', 'patch-updater', 'patch-sentry-scope', 'patch-git-output-cap'];
  fs.mkdirSync(path.join(root, "scripts"));
  for (const name of [...scripts, 'patch-util']) fs.copyFileSync(path.join(__dirname, `${name}.js`), path.join(root, "scripts", `${name}.js`));
  const directory = path.join(root, "src", "win", "_asar", ".vite", "build");
  fs.mkdirSync(directory, { recursive: true });
  const files = {
    'early-bootstrap-491-test.js': 'const html=`<div class="copyright">\\xa9 OpenAI</div>`;const windowOptions={allowInspectElement:allowed,devTools:policy.allowDevtools};const boot=function({codexHome:h=home(),startServer:s=start}){return s(h)};' + workerSource + cdpSource,
    'shared-test.js': diffSource + ';const error="diff-too-large";const updater={shouldIncludeSparkle:()=>true,shouldIncludeUpdater:()=>true};',
    'sentry-a.js': 'const marker="codex_truncated_breadcrumb_data";',
    'sentry-b.js': 'init({beforeBreadcrumb:trim});const file="scope_v3.json",limit=2097152;',
    'early-bootstrap-339-git.js': 'function execute(options){const{maxOutputBytes:n,collectOutput:c=!0}=options;return {limit:n,outputLimitExceeded:false}}',
  };
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), source);
  const snapshot = () => Object.fromEntries(Object.keys(files).map((name) => [name, fs.readFileSync(path.join(directory, name), "utf8")]));
  const run = (check) => {
    for (const name of scripts) execFileSync(process.execPath, [path.join(root, "scripts", `${name}.js`), "win", ...(check ? ['--check'] : [])], {
      env: { ...process.env, NODE_PATH: path.resolve(__dirname, "../node_modules") }, stdio: "pipe",
    });
  };
  run(true);
  assert.deepEqual(snapshot(), files);
  run(false);
  const patched = snapshot();
  assert.notDeepEqual(patched, files);
  run(false);
  run(true);
  assert.deepEqual(snapshot(), patched);
});

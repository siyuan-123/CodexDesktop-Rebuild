const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parse } = require("acorn");

const {
  NEW_COPYRIGHT_HTML,
  OLD_COPYRIGHT_HTML,
  collectPatches: collectCopyrightPatches,
} = require("./patch-copyright");
const {
  hasNativeWorkspaceRootPropagation,
} = require("./patch-composer-workspace-root");
const { hasNativeArchiveDelete } = require("./patch-archive-delete");
const {
  isElectronBootstrap,
  resolveDeclaredMain,
  selectMainEntry,
} = require("./patch-crash-forensics");
const {
  LIMITS,
  patchSource: patchWorkerLimits,
} = require("./patch-worker-limits");
const {
  patchSource: patchDiffLimits,
} = require("./patch-diff-limits");
const {
  hasNativeScopeProtection,
  patchOne: patchSentryFile,
} = require("./patch-sentry-scope");
const { isOwlRuntime } = require("./build-from-upstream");

function applyPatches(source, patches) {
  let next = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    next = next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
  }
  return next;
}

test("版权补丁兼容新版 About HTML", () => {
  const source = `const html=\`<main>${OLD_COPYRIGHT_HTML}</main>\`;`;
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const patches = collectCopyrightPatches(ast, source);

  assert.equal(patches.length, 1);
  assert.equal(applyPatches(source, patches).includes(NEW_COPYRIGHT_HTML), true);
});

test("识别上游原生工作区根目录传递链路", () => {
  const primarySource = [
    "function Qut({localConversationCwd:e,selectedRemoteProjectPath:t,defaultCwd:n,workspaceRoots:r,activeWorkspaceRoot:i,codexHome:a,canUseProjectlessThreads:o}){return e||t||n||r[0]||i}",
  ].join("");
  const sharedSource = "const query=`active-workspace-roots`;";

  assert.equal(
    hasNativeWorkspaceRootPropagation(primarySource, sharedSource),
    true,
  );
  assert.equal(
    hasNativeWorkspaceRootPropagation(
      primarySource.replace("activeWorkspaceRoot:", "root:"),
      sharedSource,
    ),
    false,
  );
});

test("识别上游原生归档会话删除功能", () => {
  const source = [
    "delete-archived-conversation",
    "delete-all-archived-conversations",
    "showDeleteButton",
    "settings.dataControls.archivedChats.deleteConfirm.title",
    "thread/delete",
  ].join("|");

  assert.equal(hasNativeArchiveDelete(source), true);
  assert.equal(hasNativeArchiveDelete(source.replace("thread/delete", "thread/archive")), false);

  const currentSource = [
    "delete-archived-conversation",
    "delete-archived-conversations",
    "deleteArchivedConversation",
    "deleteAllArchivedConversations",
    "showDeleteButton",
    "thread/delete",
  ].join("|");
  assert.equal(hasNativeArchiveDelete(currentSource), true);
});

test("主进程入口兼容 bootstrap 与哈希 main 文件", () => {
  assert.deepEqual(selectMainEntry(["bootstrap.js", "main-abc.js"]), {
    count: 1,
    file: "bootstrap.js",
  });
  assert.deepEqual(selectMainEntry(["main.js", "main-abc.js"]), {
    count: 1,
    file: "main-abc.js",
  });
  assert.deepEqual(selectMainEntry(["main-a.js", "main-b.js"]), {
    count: 2,
    file: null,
  });
  assert.equal(isElectronBootstrap('const electron=require("electron");'), true);
  assert.equal(isElectronBootstrap('const fs=require("node:fs");'), false);
});

test("优先使用上游 package.json 声明的真实主入口", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-main-test-"));
  const buildDir = path.join(directory, ".vite", "build");
  try {
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      main: ".vite/build/early-bootstrap.js",
    }));
    const expected = path.join(buildDir, "early-bootstrap.js");
    fs.writeFileSync(expected, "Promise.resolve();");
    assert.equal(resolveDeclaredMain(directory), expected);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ main: "../escape.js" }));
    assert.equal(resolveDeclaredMain(directory), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("worker 内存限制兼容 transferList 且不误匹配快照 worker", () => {
  const source = [
    "new M.Worker(snapshot,{name:`child-process-snapshot`,workerData:data});",
    "class Manager{ensureWorker(){",
    "return new M.Worker(file,{name:this.id,workerData:data,transferList:port==null?[]:[port]});",
    "}}",
  ].join("");
  const result = patchWorkerLimits(source);

  assert.equal(result.status, "patched");
  assert.equal(result.mode, "added");
  assert.equal(result.source.includes(LIMITS), true);
  assert.equal(result.source.includes("transferList:port==null?[]:[port]"), true);
  assert.equal(patchWorkerLimits(result.source).status, "already-patched");
});

test("diff 上限按数值结构匹配，不依赖压缩变量名", () => {
  const source = [
    "var jce=5*1024*1024,Z2=32*1024*1024,Mce=64*1024*1024;",
    "function cap(e){return e==null?Z2:Math.min(e,Z2)}",
  ].join("");
  const result = patchDiffLimits(source);

  assert.equal(result.status, "patched");
  assert.match(result.source, /Z2=8\*1024\*1024/);
  assert.equal(patchDiffLimits(result.source).status, "already-patched");
});

test("Sentry 补丁覆盖新版主进程 chunk 并保持幂等", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sentry-test-"));
  const file = path.join(directory, "window-all-closed-test.js");
  try {
    fs.writeFileSync(file, "const options={dsn:config.dsn,environment:config.env};");
    assert.equal(patchSentryFile(file, false), true);
    const patched = fs.readFileSync(file, "utf-8");
    assert.match(patched, /maxBreadcrumbs:20/);
    assert.equal(patchSentryFile(file, false), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("识别上游原生 Sentry scope 防膨胀保护", () => {
  const source = [
    "const codex_truncated_breadcrumb_data=true;",
    "Sentry.init({beforeBreadcrumb:trim});",
    "const scope=`scope_v3.json`;",
    "const maxBytes=2097152;",
  ].join("");

  assert.equal(hasNativeScopeProtection(source), true);
  assert.equal(
    hasNativeScopeProtection(source.replace("scope_v3.json", "scope.json")),
    false,
  );
});

test("识别新版 Windows Owl runtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owl-test-"));
  try {
    fs.mkdirSync(path.join(directory, "resources"));
    fs.writeFileSync(path.join(directory, "owl-shell-runtime.json"), "{}");
    fs.writeFileSync(path.join(directory, "resources", "owl-electron-app.json"), "{}");
    assert.equal(isOwlRuntime(directory), true);
    fs.unlinkSync(path.join(directory, "resources", "owl-electron-app.json"));
    assert.equal(isOwlRuntime(directory), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

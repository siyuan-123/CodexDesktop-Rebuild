const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { locateBuildTargets, listJavaScriptFiles } = require("./patch-util");

test("前端分片枚举包含 async 嵌套目录且排除非 JavaScript 文件", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-assets-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["app-initial-old.js", "async/1561.abcd.js", "async/nested/72.ef.js", "async/1561.abcd.js.map", "icon.svg"]) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture");
  }
  assert.deepEqual(listJavaScriptFiles(directory).map((file) => file.split(path.sep).join("/")),
    ["app-initial-old.js", "async/1561.abcd.js", "async/nested/72.ef.js"]);
  assert.deepEqual(listJavaScriptFiles(path.join(directory, "missing")), []);
});

test("按内容发现所有拆分 chunk，不依赖 main 文件名且逐平台校验", (t) => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chunks-"));
  t.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));
  const write = (platform, name, source) => {
    const file = path.join(srcDir, platform, "_asar", ".vite", "build", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  };
  const options = { srcDir, label: "保护补丁", test: (source) => source.includes("target") };
  assert.throws(() => locateBuildTargets(options), /no generated platform/);
  write("win", "early-bootstrap-824-a.js", "target");
  write("win", "shared-1-b.js", "target");
  write("win", "main-stale.js", "unrelated");
  write("win", "old.js.map", "target");
  assert.deepEqual(locateBuildTargets(options).map((entry) => path.basename(entry.path)), [
    "early-bootstrap-824-a.js", "shared-1-b.js",
  ]);
  write("mac-arm64", "main-abc.js", "unrelated");
  assert.throws(() => locateBuildTargets(options), /no matching build chunks for mac-arm64/);
  assert.equal(locateBuildTargets({ ...options, platform: "win" }).length, 2);
  assert.throws(() => locateBuildTargets({ ...options, platform: "mac-x64" }), /directory missing/);
  write("mac-arm64", "main-abc.js", "target");
  assert.equal(locateBuildTargets(options).length, 3);
});

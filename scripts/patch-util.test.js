const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { locateBuildTargets } = require("./patch-util");

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

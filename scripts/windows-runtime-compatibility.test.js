const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPackage } = require("@electron/asar");
const { assertMatchingWindowsRuntime } = require("./windows-runtime-compatibility");

async function fixture(t, { version = "26.1111.21308", build = "27194", host = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-paired-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const platform = path.join(root, "source");
  const app = path.join(root, "app");
  const original = path.join(root, "original");
  for (const dir of [path.join(platform, "_asar"), path.join(app, "resources"), original]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const manifest = { version, codexBuildNumber: build, codexWindowsAppContainedCore: "1" };
  fs.writeFileSync(path.join(original, "package.json"), JSON.stringify(manifest));
  await createPackage(original, path.join(app, "resources", "app.asar"));
  fs.writeFileSync(path.join(platform, "_asar", "package.json"), JSON.stringify({ ...manifest, codexWindowsAppContainedCore: "0" }));
  for (const name of ["codex.exe", ...(host ? ["codex-code-mode-host.exe"] : [])]) {
    for (const dir of [platform, path.join(app, "resources")]) {
      fs.writeFileSync(path.join(dir, name), `same-release:${name}`);
    }
  }
  return { platform, app };
}

test("同包清单和二进制通过，允许便携模式补丁改变非版本字段", async (t) => {
  const { platform, app } = await fixture(t);
  const result = assertMatchingWindowsRuntime(platform, app);
  assert.equal(result.version, "26.1111.21308");
  assert.deepEqual(result.binaries.map(({ name }) => name), ["codex.exe", "codex-code-mode-host.exe"]);
  assert.ok(result.binaries.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
});

for (const field of ["version", "codexBuildNumber"]) {
  test(`拒绝补丁源和缓存的 ${field} 不一致`, async (t) => {
    const { platform, app } = await fixture(t);
    const file = path.join(platform, "_asar", "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest[field] = "old";
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => assertMatchingWindowsRuntime(platform, app), new RegExp(`版本不匹配：${field}`));
  });
}

for (const name of ["codex.exe", "codex-code-mode-host.exe"]) {
  test(`版本号相同时仍拒绝单独替换 ${name}`, async (t) => {
    const { platform, app } = await fixture(t);
    fs.writeFileSync(path.join(platform, name), "different-release");
    assert.throws(() => assertMatchingWindowsRuntime(platform, app), /二进制不匹配/);
  });
}

test("拒绝仅有一侧包含 code-mode host 的不完整配套", async (t) => {
  const { platform, app } = await fixture(t, { host: false });
  fs.writeFileSync(path.join(app, "resources", "codex-code-mode-host.exe"), "host");
  assert.throws(() => assertMatchingWindowsRuntime(platform, app), /缺少配套文件 codex-code-mode-host.exe/);
});

test("兼容两侧都没有 code-mode host 的历史安装包", async (t) => {
  const { platform, app } = await fixture(t, { host: false });
  assert.equal(assertMatchingWindowsRuntime(platform, app).binaries.length, 1);
});

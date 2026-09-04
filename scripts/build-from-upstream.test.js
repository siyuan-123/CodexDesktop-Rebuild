const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createDmg,
  isRetryableHdiutilError,
  patchWindowsAsarIntegrity,
} = require("./build-from-upstream");

function createTemporaryOutput(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dmg-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    dmgPath: path.join(directory, "Codex.dmg"),
  };
}

test("识别 hdiutil 的瞬态资源占用错误", () => {
  assert.equal(isRetryableHdiutilError({ stderr: Buffer.from("hdiutil: create failed - Resource busy") }), true);
  assert.equal(isRetryableHdiutilError(new Error("Resource temporarily unavailable")), true);
  assert.equal(isRetryableHdiutilError(new Error("No space left on device")), false);
});

test("DMG 创建遇到资源占用时清理残留并退避重试", (t) => {
  const { directory, dmgPath } = createTemporaryOutput(t);
  const delays = [];
  let calls = 0;

  createDmg(directory, dmgPath, {
    attempts: 3,
    retryDelayMs: 10,
    log: () => {},
    wait: (delay) => delays.push(delay),
    run: (command, args) => {
      calls++;
      assert.equal(command, "hdiutil");
      assert.equal(args.at(-1), dmgPath);
      assert.equal(fs.existsSync(dmgPath), false);
      if (calls < 3) {
        fs.writeFileSync(dmgPath, "partial");
        const error = new Error("Command failed");
        error.stderr = Buffer.from("hdiutil: create failed - Resource busy");
        throw error;
      }
      fs.writeFileSync(dmgPath, "complete");
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(fs.readFileSync(dmgPath, "utf8"), "complete");
});

test("DMG 创建遇到确定性错误时立即失败", (t) => {
  const { directory, dmgPath } = createTemporaryOutput(t);
  let calls = 0;

  assert.throws(
    () => createDmg(directory, dmgPath, {
      attempts: 3,
      log: () => {},
      wait: () => assert.fail("不应等待重试"),
      run: () => {
        calls++;
        throw new Error("No space left on device");
      },
    }),
    /No space left on device/
  );
  assert.equal(calls, 1);
});

test("Windows Owl runtime 修补 ChatGPT.exe 中的 ASAR 哈希", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owl-integrity-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const resourcesDir = path.join(directory, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(directory, "owl-shell-runtime.json"), "{}");
  fs.writeFileSync(path.join(resourcesDir, "owl-electron-app.json"), "{}");

  const oldHash = "a".repeat(64);
  const newHash = "b".repeat(64);
  const chatGptExe = path.join(directory, "ChatGPT.exe");
  const codexExe = path.join(directory, "Codex.exe");
  fs.writeFileSync(chatGptExe, `prefix:${oldHash}:suffix`);
  fs.writeFileSync(codexExe, "launcher-without-integrity-hash");

  assert.equal(patchWindowsAsarIntegrity(directory, oldHash, newHash), chatGptExe);
  assert.equal(fs.readFileSync(chatGptExe, "utf8"), `prefix:${newHash}:suffix`);
  assert.equal(fs.readFileSync(codexExe, "utf8"), "launcher-without-integrity-hash");
});

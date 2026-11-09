const test = require("node:test");
const assert = require("node:assert/strict");
const { findPatches } = require("./patch-remote-control");

test("兼容 Rspack 导入的 rollout 调用，保持服务端能力与其他 gate", () => {
  const source = 'const visible=get(gate,"4114442250");const enabled=(0,remote.check)("1042620455");const other=(0,remote.check)("123456");const allowed=capability.available&&capability.authRequired!==true;';
  const patches = findPatches(source);
  assert.equal(patches.length, 2);
  let result = source;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, patch.start) + patch.replacement + result.slice(patch.end);
  }
  assert.ok(result.includes('(0,remote.check)("123456")'));
  assert.ok(result.includes('capability.available&&capability.authRequired!==true'));
  assert.equal(findPatches(result).length, 0);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { CAP_BYTES, hasGitExecutor, patchSource } = require("./patch-git-output-cap");

test("共享 chunk 按参数解构识别 Git 执行器，不把调用方误判为目标", () => {
  assert.equal(hasGitExecutor('function run(o){let{maxOutputBytes:n,collectOutput:c=!0}=o;return {outputLimitExceeded:false}}'), true);
  assert.equal(hasGitExecutor('const options={maxOutputBytes:1024,collectOutput:false};const result={outputLimitExceeded:false};'), false);
});

test("Git 输出上限兼容压缩变量名变化", () => {
  const source =
    "async function run(r={}){let{maxOutputBytes:u,collectOutput:d=!0}=r;return [u,d]}";

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    new RegExp(`maxOutputBytes:u=${CAP_BYTES},collectOutput:d=!0`),
  );
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("不含 Git 执行器的代码不被修改", () => {
  const source = "function run(){return true}";

  assert.equal(patchSource(source).status, "not-applicable");
});

test("Git 执行器结构漂移时明确失败", () => {
  const source =
    "function run(){const maxOutputBytes=1,collectOutput=true,outputLimitExceeded=false}";

  assert.equal(patchSource(source).status, "unexpected-shape");
});

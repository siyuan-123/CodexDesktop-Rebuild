const test = require("node:test");
const assert = require("node:assert/strict");

const { patchSource } = require("./patch-model-picker-submenu");

function createBundle(extraProps = "") {
  return [
    "function renderPicker(input){",
    `const {ariaLabel:aria,label:label,value:value,children:children,disabled:disabled,${extraProps}contentClassName:contentClassName,flyoutHeader:flyoutHeader}=input;`,
    "let inline=submenu;if(nativeInline())return inline;let flyout;",
    "return flyout;",
    "}",
  ].join("");
}

for (const [name, source] of [
  ["旧版参数结构", createBundle()],
  ["含 labelOnly 的新版参数结构", createBundle("labelOnly:labelOnly,")],
]) {
  test(`模型选择器子菜单补丁兼容${name}`, () => {
    const result = patchSource(source);

    assert.equal(result.status, "patched");
    assert.match(
      result.source,
      /if\(label\?\.props\?\.\[`data-model-picker-model-row`\]===!0\|\|typeof nativeInline===`function`&&nativeInline\(\)\)/,
    );
    assert.equal(patchSource(result.source).status, "already-patched");
  });
}

test("模型选择器子菜单补丁拒绝缺失标签锚点的结构", () => {
  const source = createBundle().replace("label:label,", "");
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-row-props-count");
  assert.equal(result.count, 0);
});

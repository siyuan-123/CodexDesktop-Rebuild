const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parse } = require("acorn");

const {
  TRANSLATIONS,
  patchSource,
  findTargets,
} = require("./patch-reasoning-effort-labels");

test("数字分片通过 locale 导入映射定位简体中文，不修改其他语言", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-locales-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "win/_asar/webview/assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  fs.writeFileSync(path.join(assets, "async/registry.hash.js"),
    'const locales={"../locales/zh-CN.json":function(){return i.e(1561).then(i.t.bind(i,"cn",19))},"../locales/zh-TW.json":function(){return i.e(256801).then(i.t.bind(i,"tw",19))}}');
  for (const name of ["1561.hash.js", "256801.hash.js"]) {
    fs.writeFileSync(path.join(assets, "async", name), "export const locale={}");
  }
  const result = findTargets("win", root);
  assert.deepEqual(result.invalidPlatforms, []);
  assert.deepEqual(result.targets.map((item) => path.basename(item.path)), ["1561.hash.js"]);
});

test("Rspack JSON 语言包补丁保留其他消息、引号转义且重复执行稳定", () => {
  const messages = { ...TRANSLATIONS, "composer.mode.local.reasoning.none.label": "无", unrelated: "引号'与反斜线\\" };
  const source = `export const __webpack_modules__={cn(e){e.exports=JSON.parse(${JSON.stringify(JSON.stringify(messages))})}}`;
  const result = patchSource(source);
  assert.equal(result.status, "patched");
  const ast = parse(result.source, { ecmaVersion: "latest", sourceType: "module" });
  const literal = ast.body[0].declaration.declarations[0].init.properties[0].value.body.body[0].expression.right.arguments[0];
  assert.deepEqual(JSON.parse(literal.value), { ...messages, ...TRANSLATIONS });
  assert.equal(patchSource(result.source).status, "already-patched");
  delete messages["composer.mode.local.reasoning.max.label"];
  const incomplete = `JSON.parse(${JSON.stringify(JSON.stringify(messages))})`;
  assert.equal(patchSource(incomplete).status, "unexpected-entry-count");
});

function createLocaleSource(overrides = {}) {
  const translations = { ...TRANSLATIONS, ...overrides };
  const entries = Object.keys(TRANSLATIONS).map(
    (messageId) => `"${messageId}":\`${translations[messageId]}\``,
  );
  return `const messages={${entries.join(",")}};export{messages as default};`;
}

test("为全部推理强度补充实际参数并说明 Ultra", () => {
  const source = createLocaleSource({
    "composer.mode.local.reasoning.low.label.v2": "轻度",
    "composer.mode.local.reasoning.ultra.label": "极高",
    "composer.modelPicker.power.ultraUsageWarning": "更快消耗使用额度",
  });

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  for (const [messageId, translation] of Object.entries(TRANSLATIONS)) {
    assert.match(result.source, new RegExp(`"${messageId.replaceAll(".", "\\.")}":\`${translation}\``));
  }
});

test("兼容旧版 low 消息 ID", () => {
  const source = createLocaleSource({
    "composer.mode.local.reasoning.low.label.v2": "轻度",
  }).replace(
    "composer.mode.local.reasoning.low.label.v2",
    "composer.mode.local.reasoning.low.label",
  );

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    /"composer\.mode\.local\.reasoning\.low\.label":`轻度（low）`/,
  );
});

test("重复执行不会再次修改语言包", () => {
  const source = createLocaleSource();
  const result = patchSource(source);

  assert.equal(result.status, "already-patched");
  assert.equal(result.source, source);
});

test("关键消息缺失时失败，避免静默产生不完整补丁", () => {
  const source = createLocaleSource().replace(
    /"composer\.mode\.local\.reasoning\.max\.label":`[^`]*`,?/,
    "",
  );
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-entry-count");
  assert.deepEqual(result.invalidEntries, [
    {
      messageId: "composer.mode.local.reasoning.max.label",
      count: 0,
    },
  ]);
});

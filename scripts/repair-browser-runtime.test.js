const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parse } = require("acorn");
const { RUNTIME_DIRS, RUNTIME_FILES, assertNetworkPolicySupport, planRepair, applyRepair } = require("./repair-browser-runtime");
const { ROUTING_FILES, patchSource } = require("./patch-windows-browser-routing");

const SERVICE = `class Preferences {
  async getNetworkPolicy() { return [await this.config.readRequirements(), await this.config.readAll()] }
}
class Client { attach(tab, policy) { return this.sendSessionRequest("attach", {tabId: tab, networkPolicy: policy}) } }
class CDP { async attachTab(tab) { return this.api.attach(tab, await this.readNetworkPolicy()) } }`;
const SKILL = '---\nname: computer-use\ndescription: Control Windows apps\n---\n\n# Computer Use\n\n## Initialize\nconst { sky } = await import("@oai/sky");\n';
const COMPUTER = 'Use an app from inventory.\nlet app = await cua.getApp("Example App");\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const resourcesRoot = path.join(root, "resources");
  for (const directory of RUNTIME_DIRS) {
    for (const [base, current] of [[sourceRoot, true], [resourcesRoot, false]]) {
      fs.mkdirSync(path.join(base, directory), { recursive: true });
      for (const name of RUNTIME_FILES) {
        const content = name === "browser-service.mjs" ? (current ? SERVICE : "export const legacy = true;")
          : name.endsWith(".mjs") ? `export const revision = ${current ? 2 : 1};` : Buffer.from(current ? [0, 2, 255] : [0, 1, 255]);
        fs.writeFileSync(path.join(base, directory, name), content);
      }
    }
  }
  for (const target of ROUTING_FILES) {
    const file = path.join(resourcesRoot, target.relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, target.kind === "skill" ? SKILL : COMPUTER);
  }
  fs.writeFileSync(path.join(resourcesRoot, "codex.exe"), "unchanged-cli");
  return { root, sourceRoot, resourcesRoot };
}

test("检查模式只读，应用时成套同步、保留备份且可重复执行", (t) => {
  const options = fixture(t);
  const before = planRepair(options);
  const output = execFileSync(process.execPath, [path.join(__dirname, "repair-browser-runtime.js"),
    "--source", options.sourceRoot, "--resources", options.resourcesRoot, "--check"], { encoding: "utf8" });
  assert.match(output, /require update/);
  for (const item of before) assert.deepEqual(fs.readFileSync(item.file), item.before);
  assert.equal(fs.existsSync(path.join(options.root, "browser-runtime-backups")), false);
  const backup = applyRepair(before, path.join(options.root, "backups"));
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json")));
  assert.equal(manifest.length, before.length);
  for (const [index, item] of before.entries()) {
    assert.deepEqual(fs.readFileSync(item.file), item.data);
    assert.deepEqual(fs.readFileSync(path.join(backup, manifest[index].backup)), item.before);
  }
  assert.equal(fs.readFileSync(path.join(options.resourcesRoot, "codex.exe"), "utf8"), "unchanged-cli");
  assert.equal(planRepair(options).length, 0);
});

test("最后一个入口缺少资源时，全部预检失败且不产生写入", (t) => {
  const options = fixture(t);
  const before = planRepair(options);
  fs.unlinkSync(path.join(options.sourceRoot, RUNTIME_DIRS.at(-1), "zxing_reader.wasm"));
  assert.throws(() => planRepair(options), /ENOENT/);
  for (const item of before) assert.deepEqual(fs.readFileSync(item.file), item.before);
});

test("不把缺少策略读取或传递的旧运行时安装为修复", () => {
  assert.doesNotThrow(() => assertNetworkPolicySupport(SERVICE, "complete"));
  assert.throws(() => assertNetworkPolicySupport(SERVICE.replace("await this.config.readRequirements()", "null"), "partial"), /networkPolicy/);
  assert.throws(() => assertNetworkPolicySupport(SERVICE.replace("networkPolicy: policy", "other: policy"), "partial"), /networkPolicy/);
  assert.throws(() => assertNetworkPolicySupport(SERVICE.replace(", await this.readNetworkPolicy()", ""), "partial"), /networkPolicy/);
});

test("写入中途失败时恢复所有触碰的文件", (t) => {
  const options = fixture(t);
  const plan = planRepair(options);
  let calls = 0;
  assert.throws(() => applyRepair(plan, path.join(options.root, "backups"), (file, data) => {
    fs.writeFileSync(file, data);
    if (++calls === 2) throw new Error("模拟磁盘写入失败");
  }), /已回滚/);
  for (const item of plan) assert.deepEqual(fs.readFileSync(item.file), item.before);
});

test("计划建立后目标变化时拒绝覆盖", (t) => {
  const options = fixture(t);
  const plan = planRepair(options);
  fs.writeFileSync(plan[0].file, "changed-by-user");
  assert.throws(() => applyRepair(plan, path.join(options.root, "backups")), /目标已变化/);
  assert.equal(fs.readFileSync(plan[0].file, "utf8"), "changed-by-user");
  assert.equal(fs.existsSync(path.join(options.root, "backups")), false);
});

test("同步已安装插件缓存，不改其他插件和用户配置", (t) => {
  const options = fixture(t);
  options.codexHome = path.join(options.root, "codex-home");
  const cache = path.join(options.codexHome, "plugins/cache/openai-bundled");
  fs.mkdirSync(cache, { recursive: true });
  for (const plugin of ["browser", "chrome"]) {
    fs.cpSync(path.join(options.resourcesRoot, `plugins/openai-bundled/plugins/${plugin}`),
      path.join(cache, plugin, "26.1016.51333"), { recursive: true });
  }
  fs.cpSync(path.join(options.resourcesRoot, "plugins/openai-bundled/plugins/computer-use"),
    path.join(cache, "computer-use/26.1016.51333"), { recursive: true });
  fs.writeFileSync(path.join(options.codexHome, "config.toml"), "existing-user-config");
  const plan = planRepair(options);
  assert.equal(plan.filter((item) => item.file.startsWith(cache)).length, 9);
  applyRepair(plan, path.join(options.root, "backups"));
  assert.equal(planRepair(options).length, 0);
  assert.equal(fs.readFileSync(path.join(options.codexHome, "config.toml"), "utf8"), "existing-user-config");
});

test("技能修补保留原生工作流和换行，重复执行不追加内容", () => {
  const source = SKILL.replace(/\n/g, "\r\n");
  const first = patchSource(source, "skill");
  assert.equal(first.changed, true);
  assert.ok(first.source.endsWith(source.slice(source.indexOf("## Initialize"))));
  assert.equal(first.source.replace(/\r\n/g, "").includes("\n"), false);
  assert.deepEqual(patchSource(first.source, "skill"), { source: first.source, changed: false });
  assert.throws(() => patchSource("unknown upstream", "skill"), /未知/);
});

test("真实生成运行时向扩展传递原始策略，读取失败时终止 attach", async (t) => {
  const sourceRoot = path.join(__dirname, "../src/win");
  if (!fs.existsSync(sourceRoot)) return t.skip("未生成 Windows 上游资源");
  for (const directory of RUNTIME_DIRS) {
    const source = fs.readFileSync(path.join(sourceRoot, directory, "browser-service.mjs"), "utf8");
    assertNetworkPolicySupport(source, directory);
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    let attach;
    let attachTab;
    function walk(node) {
      if (!node?.type) return;
      if (node.type === "MethodDefinition") {
        const raw = source.slice(node.start, node.end);
        if (node.key.name === "attach" && raw.includes("networkPolicy:")) attach = raw;
        if (node.key.name === "attachTab" && raw.includes("this.readNetworkPolicy()")) attachTab = raw;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value?.type) walk(value);
      }
    }
    walk(ast);
    const Client = Function(`return class { ${attach} }`)();
    const client = new Client();
    const policy = { constraints: [{ kind: "origins", mode: "denylist", patterns: ["https://blocked.example"] }] };
    client.sendSessionRequest = (method, params) => ({ method, params });
    const forwarded = client.attach(7, policy);
    assert.equal(forwarded.method, "attach");
    assert.equal(forwarded.params.networkPolicy, policy);
    const CDP = Function(`return class { ${attachTab} }`)();
    const cdp = new CDP();
    cdp.readNetworkPolicy = async () => { throw new Error("policy unavailable"); };
    cdp.api = { attach: () => assert.fail("策略读取失败后不应接管标签页") };
    await assert.rejects(cdp.attachTab(7, {}, () => true), /policy unavailable/);
  }
});

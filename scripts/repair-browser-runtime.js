#!/usr/bin/env node
/**
 * 将已生成的 Windows Browser Use 运行时同步到指定安装目录和可选插件缓存。
 * 客户端、服务端及 WASM 资源成套更新；全部预检后备份，失败时回滚本次写入。
 * 不修改 CLI、原生 helper、认证、网站策略或扩展本身。
 *
 * node scripts/repair-browser-runtime.js --resources <安装目录/resources> [--codex-home <目录>] [--check]
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { parse } = require("acorn");
const { SRC_DIR } = require("./patch-util");
const { planRouting, patchSource } = require("./patch-windows-browser-routing");

const RUNTIME_DIRS = [
  "cua_node/bin/node_modules/@oai/browser-desktop/scripts",
  "cua_node/bin/node_modules/@oai/cua/dist/lib/js/oai_js_browser/dist/skill/scripts",
  "plugins/openai-bundled/plugins/browser/scripts",
  "plugins/openai-bundled/plugins/chrome/scripts",
];
const RUNTIME_FILES = [
  "browser-client.mjs", "browser-service.mjs",
  "browser-accessibility.wasm.br", "zxing_reader.wasm",
];

function walk(node, visit) {
  if (!node?.type) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function assertNetworkPolicySupport(source, label) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  let readsPolicy = false;
  let forwardsPolicy = false;
  let attachesPolicy = false;
  walk(ast, (node) => {
    if (node.type === "MethodDefinition") {
      const body = source.slice(node.start, node.end);
      if (node.key.name === "getNetworkPolicy" &&
          body.includes("this.config.readRequirements()") && body.includes("this.config.readAll()")) readsPolicy = true;
      if (node.key.name === "attach" && body.includes("networkPolicy:") &&
          body.includes("this.sendSessionRequest(")) forwardsPolicy = true;
    }
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" &&
        node.callee.property.name === "attach" && node.arguments[1]?.type === "AwaitExpression" &&
        source.slice(node.arguments[1].start, node.arguments[1].end).includes("this.readNetworkPolicy()")) attachesPolicy = true;
  });
  if (!readsPolicy || !forwardsPolicy || !attachesPolicy) {
    throw new Error(`${label}: 缺少完整 networkPolicy 协议，请先同步兼容的上游资源`);
  }
}

function planRepair({ sourceRoot = path.join(SRC_DIR, "win"), resourcesRoot, codexHome }) {
  if (!resourcesRoot) throw new Error("必须指定 --resources");
  const plan = [];
  const validated = new Set();
  function addDirectory(sourceDirectory, destinationDirectory) {
    const service = path.join(sourceDirectory, "browser-service.mjs");
    if (!validated.has(service)) {
      assertNetworkPolicySupport(fs.readFileSync(service, "utf8"), service);
      validated.add(service);
    }
    const files = [...RUNTIME_FILES];
    if (fs.existsSync(path.join(sourceDirectory, "browser-client.js"))) files.push("browser-client.js");
    for (const name of files) {
      const source = path.join(sourceDirectory, name);
      const file = path.join(destinationDirectory, name);
      const data = fs.readFileSync(source);
      // 不创建不存在的安装入口，防止路径错误变成一次不完整安装。
      const before = fs.readFileSync(file);
      if (name.endsWith(".mjs") || name.endsWith(".js")) {
        parse(data.toString("utf8"), { ecmaVersion: "latest", sourceType: "module" });
      }
      if (!data.equals(before)) plan.push({ file, data, before });
    }
  }
  for (const directory of RUNTIME_DIRS) {
    addDirectory(path.join(sourceRoot, directory), path.join(resourcesRoot, directory));
  }
  for (const item of planRouting(resourcesRoot)) {
    if (item.changed) plan.push({ file: item.file, data: Buffer.from(item.source), before: fs.readFileSync(item.file) });
  }
  if (codexHome) {
    const cache = path.join(codexHome, "plugins/cache/openai-bundled");
    for (const plugin of ["browser", "chrome", "computer-use"]) {
      const directory = path.join(cache, plugin);
      if (!fs.existsSync(directory)) continue;
      for (const version of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!version.isDirectory() || !/^\d+(?:\.\d+)+$/.test(version.name)) continue;
        const pluginRoot = path.join(directory, version.name);
        if (plugin !== "computer-use") {
          addDirectory(path.join(sourceRoot, "plugins/openai-bundled/plugins", plugin, "scripts"), path.join(pluginRoot, "scripts"));
        } else {
          const file = path.join(pluginRoot, "skills/computer-use/SKILL.md");
          const before = fs.readFileSync(file);
          const result = patchSource(before.toString("utf8"), "skill");
          if (result.changed) plan.push({ file, before, data: Buffer.from(result.source) });
        }
      }
    }
  }
  return plan;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function applyRepair(plan, backupRoot, write = fs.writeFileSync) {
  if (plan.length === 0) return null;
  // 先检查计划是否过期，再保存全部旧内容；备份失败时不会触碰目标。
  for (const item of plan) {
    if (!fs.readFileSync(item.file).equals(item.before)) throw new Error(`目标已变化，请重新检查：${item.file}`);
  }
  fs.mkdirSync(backupRoot, { recursive: true });
  const backup = fs.mkdtempSync(path.join(backupRoot, "browser-"));
  const manifest = plan.map((item, index) => {
    const name = `${index}.bak`;
    fs.writeFileSync(path.join(backup, name), item.before);
    return { file: item.file, backup: name, beforeSha256: sha256(item.before), afterSha256: sha256(item.data) };
  });
  fs.writeFileSync(path.join(backup, "manifest.json"), JSON.stringify(manifest, null, 2));
  const touched = [];
  try {
    for (const item of plan) {
      touched.push(item);
      write(item.file, item.data);
      if (!fs.readFileSync(item.file).equals(item.data)) throw new Error(`写入校验失败：${item.file}`);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of touched.reverse()) {
      try { fs.writeFileSync(item.file, item.before); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    throw new AggregateError([error, ...rollbackErrors], `浏览器修复失败；${rollbackErrors.length ? "部分回滚失败" : "已回滚"}；备份：${backup}`);
  }
  return backup;
}

function main() {
  const args = process.argv.slice(2);
  const options = { check: false };
  const flags = { "--resources": "resourcesRoot", "--source": "sourceRoot", "--codex-home": "codexHome" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--check") options.check = true;
    else if (flags[flag] && args[index + 1] && !args[index + 1].startsWith("--")) options[flags[flag]] = path.resolve(args[++index]);
    else throw new Error(`未知或不完整参数：${flag}`);
  }
  const plan = planRepair(options);
  for (const item of plan) console.log(`[${options.check ? "?" : "*"}] ${item.file}`);
  const backup = options.check ? null : applyRepair(plan, path.resolve(options.resourcesRoot, "..", "browser-runtime-backups"));
  console.log(`[ok] ${plan.length} file(s) ${options.check ? "require update" : "updated"}${backup ? `; backup: ${backup}` : ""}`);
}

if (require.main === module) main();
module.exports = { RUNTIME_DIRS, RUNTIME_FILES, assertNetworkPolicySupport, planRepair, applyRepair };

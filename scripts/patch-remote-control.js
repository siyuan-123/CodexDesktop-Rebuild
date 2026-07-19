#!/usr/bin/env node
/**
 * 构建后补丁：开启“连接 / 手机远程控制”入口。
 *
 * 上游当前使用两个 Statsig gate 控制入口：
 *   - 4114442250：显示 Connections 设置项与路由
 *   - 1042620455：启用 Remote Control（Slingshot）数据加载与设置分区
 *
 * 这里只绕过客户端 rollout gate，不修改服务端返回的 available、
 * accessRequired、authRequired 等能力状态。这样账号没有服务端权限时，
 * 仍会保留真实错误，而不是显示一个必然失败的伪可用状态。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const GATES = new Map([
  ["4114442250", "remote_connections_visibility"],
  ["1042620455", "remote_control_slingshot"],
]);

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function marker(gateId) {
  return `/*codex-remote-gate:${gateId}*/`;
}

function findPatches(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "Identifier") return;

    const gateId = node.arguments
      ?.map((argument) => String(getLiteralValue(argument) ?? ""))
      .find((value) => GATES.has(value));
    if (!gateId) return;
    const gateName = GATES.get(gateId);
    if (!gateName) return;

    patches.push({
      id: gateName,
      gateId,
      start: node.start,
      end: node.end,
      original: source.slice(node.start, node.end),
      replacement: `!0${marker(gateId)}`,
    });
  });

  return patches;
}

function locatePlatforms(platform) {
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"].filter((name) =>
    fs.existsSync(path.join(SRC_DIR, name, "_asar", "webview", "assets")),
  );
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  const platforms = locatePlatforms(platform);

  if (platforms.length === 0) {
    console.log("[skip] No generated platform assets found");
    return;
  }

  let changedFiles = 0;
  let pendingFiles = 0;

  for (const targetPlatform of platforms) {
    const assetsDir = path.join(SRC_DIR, targetPlatform, "_asar", "webview", "assets");
    const counts = new Map([...GATES.keys()].map((gateId) => [gateId, { patched: 0, marked: 0 }]));

    for (const name of fs.readdirSync(assetsDir)) {
      if (!name.endsWith(".js")) continue;
      const file = path.join(assetsDir, name);
      const source = fs.readFileSync(file, "utf8");
      const relevant = [...GATES.keys()].some(
        (gateId) => source.includes(gateId) || source.includes(marker(gateId)),
      );
      if (!relevant) continue;

      for (const gateId of GATES.keys()) {
        counts.get(gateId).marked += source.split(marker(gateId)).length - 1;
      }

      const patches = findPatches(source);
      if (patches.length === 0) continue;

      console.log(`\n-- [${targetPlatform}] ${relPath(file)}`);
      for (const patch of patches) {
        counts.get(patch.gateId).patched++;
        console.log(
          `   ${isCheck ? "[?]" : "*"} [${patch.id}] ${patch.original} -> ${patch.replacement}`,
        );
      }

      if (isCheck) {
        pendingFiles++;
        continue;
      }

      patches.sort((a, b) => b.start - a.start);
      let code = source;
      for (const patch of patches) {
        code = code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
      }
      fs.writeFileSync(file, code, "utf8");
      changedFiles++;
    }

    for (const [gateId, gateName] of GATES) {
      const count = counts.get(gateId);
      if (count.patched === 0 && count.marked === 0) {
        throw new Error(`[${targetPlatform}] Remote-control gate not found: ${gateName} (${gateId})`);
      }
      const state = count.patched > 0 ? `${count.patched} match(es)` : `${count.marked} marker(s)`;
      console.log(`   [ok] [${targetPlatform}] ${gateName}: ${state}`);
    }
  }

  console.log(
    isCheck
      ? `[check] ${pendingFiles} file(s) would be changed`
      : `[done] ${changedFiles} file(s) patched`,
  );
}

main();

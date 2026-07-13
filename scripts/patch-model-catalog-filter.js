#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const OLD_FILTER_RE = /if\(([$A-Z_a-z][\w$]*)\?([$\w]+)\.has\(([$\w]+)\.model\):!\3\.hidden\)/g;

function getPlatforms(platform) {
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"].filter((p) =>
    fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
  );
}

function findTargets(platform) {
  const targets = [];
  for (const plat of getPlatforms(platform)) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;

    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf-8");
      if (
        source.includes("availableModels") &&
        source.includes("useHiddenModels") &&
        source.includes(".hidden")
      ) {
        targets.push({ platform: plat, path: filePath, source });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const targets = findTargets(platform);
  if (targets.length === 0) {
    console.log("  [skip] No model catalog filter bundle found");
    return;
  }

  let patched = 0;
  for (const target of targets) {
    const label = relPath(target.path);
    const matches = [...target.source.matchAll(OLD_FILTER_RE)];

    if (matches.length === 0) {
      if (target.source.includes("if(!") && target.source.includes(".hidden")) {
        console.log(`  [ok] ${label}: already patched or no allowlist gate`);
      } else {
        console.log(`  [!] ${label}: no matching filter gate`);
      }
      continue;
    }

    if (matches.length !== 1) {
      console.log(`  [!] ${label}: expected 1 filter gate, found ${matches.length}`);
      continue;
    }

    const modelVar = matches[0][3];
    const replacement = `if(!${modelVar}.hidden)`;
    if (isCheck) {
      console.log(`  [?] ${label}: ${matches[0][0]} -> ${replacement}`);
      patched++;
      continue;
    }

    const next = target.source.replace(OLD_FILTER_RE, replacement);
    fs.writeFileSync(target.path, next, "utf-8");
    console.log(`  [ok] ${label}: ignored Statsig available_models allowlist`);
    patched++;
  }

  if (isCheck) {
    console.log(`  [check] ${patched} model filter bundle(s) would be patched`);
  } else {
    console.log(`  [done] ${patched} model filter bundle(s) patched`);
  }
}

main();

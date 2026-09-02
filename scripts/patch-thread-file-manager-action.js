#!/usr/bin/env node
/**
 * 将对话右键菜单的系统文件管理器入口提升到顶层。
 *
 * 26.825 起，上游把工作区的所有打开目标统一收进“打开方式”子菜单。
 * 本补丁保留该子菜单，同时复用同一打开链路增加顶层入口；直接打开不会
 * 改写用户的默认打开目标。旧版若已提供 open-thread-folder，则安全跳过。
 *
 * Usage:
 *   node scripts/patch-thread-file-manager-action.js [platform]
 *   node scripts/patch-thread-file-manager-action.js --check
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const MARKER = "/* Codex：对话菜单直接显示系统文件管理器入口。 */";
const DIRECT_ACTION_ID = "open-workspace-file-manager-direct";
const PATCHABLE_SIGNATURES = [
  "localConversation.openTarget.error",
  "localConversationPage.openPrimaryTarget",
  "persistPreferredTargetPath",
  "threadHeader.copyActions",
];

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visitor);
    } else if (value && typeof value === "object" && value.type) {
      walk(value, visitor);
    }
  }
}

function propertyName(property) {
  if (property?.key?.type === "Identifier") return property.key.name;
  if (property?.key?.type === "Literal") return property.key.value;
  return null;
}

function objectPatternBindings(pattern) {
  const bindings = new Map();
  if (pattern?.type !== "ObjectPattern") return bindings;

  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    const value =
      property.value?.type === "Identifier"
        ? property.value
        : property.value?.type === "AssignmentPattern" &&
            property.value.left?.type === "Identifier"
          ? property.value.left
          : null;
    if (key != null && value != null) bindings.set(key, value.name);
  }
  return bindings;
}

function functionBindings(node) {
  const direct = objectPatternBindings(node.params[0]);
  if (direct.size > 0 || node.params[0]?.type !== "Identifier") return direct;

  const parameter = node.params[0].name;
  for (const statement of node.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (
        declaration.id?.type === "ObjectPattern" &&
        declaration.init?.type === "Identifier" &&
        declaration.init.name === parameter
      ) {
        return objectPatternBindings(declaration.id);
      }
    }
  }
  return direct;
}

function hasNativeDirectAction(source) {
  return /id:\s*[`'"](?:open-thread-folder|reveal-thread-folder)[`'"]/.test(
    source,
  );
}

function parse(source) {
  return acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
}

function findPatchContext(ast, source) {
  const menuBuilders = [];
  const openHelpers = [];

  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || node.id?.type !== "Identifier") {
      return;
    }

    const bindings = functionBindings(node);
    const mayBuildMenu = ["scope", "cwd", "hostId"].every((key) =>
      bindings.has(key),
    );
    const mayOpenItem = [
      "scope",
      "cwd",
      "hostId",
      "path",
      "target",
      "openMode",
    ].every((key) => bindings.has(key));
    if (!mayBuildMenu && !mayOpenItem) return;
    const code = source.slice(node.start, node.end);

    if (
      mayBuildMenu &&
      code.includes("localConversation.openTarget.error") &&
      code.includes("persistPreferredTargetPath") &&
      code.includes("openMode:`workspace`") &&
      code.includes(".query.fetch(")
    ) {
      const scope = bindings.get("scope");
      const returns = node.body.body.filter(
        (statement) =>
          statement.type === "ReturnStatement" &&
          statement.argument?.type === "CallExpression",
      );
      const targetsVariables = [];
      for (const statement of node.body.body) {
        if (statement.type !== "VariableDeclaration") continue;
        for (const declaration of statement.declarations) {
          const callee = declaration.init?.callee;
          if (
            declaration.id?.type === "Identifier" &&
            declaration.init?.type === "CallExpression" &&
            callee?.type === "MemberExpression" &&
            callee.computed === false &&
            callee.property?.name === "getData" &&
            callee.object?.type === "MemberExpression" &&
            callee.object.computed === false &&
            callee.object.object?.type === "Identifier" &&
            callee.object.object.name === scope &&
            callee.object.property?.name === "query"
          ) {
            targetsVariables.push(declaration.id.name);
          }
        }
      }
      menuBuilders.push({ bindings, returns, targetsVariables });
    }

    if (
      mayOpenItem &&
      code.includes("persistPreferredTargetPath") &&
      code.includes("openInSidePanel")
    ) {
      openHelpers.push(node.id.name);
    }
  });

  return { menuBuilders, openHelpers };
}

function fileManagerMessageExpression(platformVariable) {
  const finder =
    "{id:`sidebarElectron.openWorkspaceRootInFinder`," +
    "defaultMessage:`Reveal in Finder`," +
    "description:`Menu item to reveal a folder in Finder`}";
  const explorer =
    "{id:`sidebarElectron.openWorkspaceRootInExplorer`," +
    "defaultMessage:`Open in Explorer`," +
    "description:`Menu item to open a folder in File Explorer`}";
  const fileManager =
    "{id:`sidebarElectron.openWorkspaceRootInFileManager`," +
    "defaultMessage:`Open in File Manager`," +
    "description:`Menu item to open a folder in the system file manager`}";

  return (
    `${platformVariable}.startsWith(\`mac\`)?${finder}:` +
    `${platformVariable}.startsWith(\`win\`)?${explorer}:${fileManager}`
  );
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    return { status: "already-patched", source };
  }
  const hasNativeAction = hasNativeDirectAction(source);
  const hasPatchableSignatures = PATCHABLE_SIGNATURES.every((signature) =>
    source.includes(signature),
  );
  if (hasNativeAction && !hasPatchableSignatures) {
    return { status: "native", source };
  }

  let ast;
  try {
    ast = parse(source);
  } catch (error) {
    return { status: "parse-failed", phase: "before", error, source };
  }

  const { menuBuilders, openHelpers } = findPatchContext(ast, source);
  if (menuBuilders.length === 0 && hasNativeAction) {
    return { status: "native", source };
  }
  if (menuBuilders.length !== 1) {
    return {
      status: "unexpected-menu-builder-count",
      count: menuBuilders.length,
      source,
    };
  }
  if (openHelpers.length !== 1) {
    return {
      status: "unexpected-open-helper-count",
      count: openHelpers.length,
      source,
    };
  }

  const [{ bindings, returns, targetsVariables }] = menuBuilders;
  if (returns.length !== 1) {
    return {
      status: "unexpected-return-count",
      count: returns.length,
      source,
    };
  }

  const [returnNode] = returns;
  const scope = bindings.get("scope");
  const cwd = bindings.get("cwd");
  const hostId = bindings.get("hostId");
  const originalItems = source.slice(
    returnNode.argument.start,
    returnNode.argument.end,
  );
  const itemsVariable = "__codexOpenWorkspaceItems";
  const targetVariable = "__codexFileManagerTarget";
  const platformVariable = "__codexDesktopPlatform";
  const replacement = [
    `let ${itemsVariable}=${originalItems};`,
    ...(targetsVariables.length === 1
      ? [
          `let ${targetVariable}=${targetsVariables[0]}?.targets.find(` +
            `e=>e.target===\`fileManager\`);`,
        ]
      : []),
    `let ${platformVariable}=(` +
      `globalThis.navigator?.userAgentData?.platform??` +
      `globalThis.navigator?.platform??\`\`).toLowerCase();`,
    "return[",
    `{${MARKER}`,
    `id:\`${DIRECT_ACTION_ID}\`,`,
    `message:${fileManagerMessageExpression(platformVariable)},`,
    `icon:${
      targetsVariables.length === 1
        ? `${targetVariable}?.resolvedIcon??${targetVariable}?.icon??`
        : ""
    }${itemsVariable}[0]?.icon,`,
    `onSelect:()=>${openHelpers[0]}({`,
    `scope:${scope},path:${cwd},cwd:${cwd},hostId:${hostId},`,
    "target:`fileManager`,openMode:`workspace`",
    "})},",
    `...${itemsVariable}]`,
  ].join("");
  const next =
    source.slice(0, returnNode.start) +
    replacement +
    source.slice(returnNode.end);

  try {
    parse(next);
  } catch (error) {
    return { status: "parse-failed", phase: "after", error, source };
  }

  return { status: "patched", source: next };
}

function findTargets(platform) {
  return locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    ...(platform ? { platform } : {}),
  })
    .map((target) => ({
      ...target,
      source: fs.readFileSync(target.path, "utf-8"),
    }))
    .filter(
      ({ source }) =>
        source.includes(MARKER) ||
        hasNativeDirectAction(source) ||
        PATCHABLE_SIGNATURES.every((signature) => source.includes(signature)),
    );
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((item) => PLATFORMS.includes(item));
  const targets = findTargets(platform);

  if (targets.length === 0) {
    console.log("  [skip] No matching thread action bundle found");
    return;
  }

  let patched = 0;
  let failed = 0;
  for (const target of targets) {
    const label = relPath(target.path);
    const result = patchSource(target.source);

    if (result.status === "native") {
      console.log(
        `  [ok] ${label}: upstream exposes the thread folder action directly`,
      );
      continue;
    }
    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }
    if (result.status === "patched") {
      if (isCheck) {
        console.log(`  [?] ${label}: would expose the file manager action`);
      } else {
        fs.writeFileSync(target.path, result.source, "utf-8");
        console.log(`  [ok] ${label}: file manager action exposed`);
      }
      patched++;
      continue;
    }

    const detail =
      result.count == null
        ? result.error?.message ?? result.status
        : `${result.status} (${result.count})`;
    console.log(`  [x] ${label}: ${detail}`);
    failed++;
  }

  console.log(
    `  [done] ${isCheck ? "would patch" : "patched"} ${patched} file(s)`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  DIRECT_ACTION_ID,
  MARKER,
  findTargets,
  hasNativeDirectAction,
  patchSource,
};

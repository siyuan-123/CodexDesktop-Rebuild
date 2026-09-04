#!/usr/bin/env node
/**
 * 将对话右键菜单的系统文件管理器入口提升到顶层。
 *
 * 26.825 起，上游把工作区的所有打开目标统一收进“打开方式”子菜单；
 * 26.901 又把侧边栏会话菜单拆到 app-primary，并仅为 Git 会话调用该菜单。
 * 本补丁先复用打开链路增加顶层入口，再放宽侧边栏的 Git 限制，使所有
 * 有工作目录的本地会话都能显示入口。旧版若已提供 open-thread-folder，
 * 则安全跳过。
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
const SIDEBAR_MARKER =
  "/* Codex：侧边栏会话菜单对普通目录显示打开入口。 */";
const DIRECT_ACTION_ID = "open-workspace-file-manager-direct";
const PATCHABLE_SIGNATURES = [
  "localConversation.openTarget.error",
  "localConversationPage.openPrimaryTarget",
  "persistPreferredTargetPath",
];
const SIDEBAR_PATCHABLE_SIGNATURES = [
  "id:`rename-thread`",
  "id:`archive-thread`",
  "id:`open-in-new-window`",
  "remote_control_connections",
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

function walkWithAncestors(node, visitor, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) {
    visitor(node, ancestors);
    ancestors.push(node);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkWithAncestors(child, visitor, ancestors);
    } else if (value && typeof value === "object" && value.type) {
      walkWithAncestors(value, visitor, ancestors);
    }
  }
  if (node.type) ancestors.pop();
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

function bodyObjectBindings(node, sourceBinding) {
  if (sourceBinding == null) return new Map();
  for (const statement of node.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (
        declaration.id?.type === "ObjectPattern" &&
        declaration.init?.type === "Identifier" &&
        declaration.init.name === sourceBinding
      ) {
        return objectPatternBindings(declaration.id);
      }
    }
  }
  return new Map();
}

function objectExpressionProperties(node) {
  const properties = new Map();
  if (node?.type !== "ObjectExpression") return properties;
  for (const property of node.properties) {
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    if (key != null) properties.set(key, property.value);
  }
  return properties;
}

function memberName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property?.type === "Literal") {
    return node.property.value;
  }
  return null;
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

function findSidebarPatchContexts(ast, source) {
  const contexts = [];

  walk(ast, (functionNode) => {
    if (
      functionNode.type !== "FunctionDeclaration" ||
      functionNode.id?.type !== "Identifier"
    ) {
      return;
    }

    const code = source.slice(functionNode.start, functionNode.end);
    if (
      !SIDEBAR_PATCHABLE_SIGNATURES.every((signature) =>
        code.includes(signature),
      )
    ) {
      return;
    }

    const bindings = functionBindings(functionNode);
    const scope = bindings.get("scope");
    const target = bindings.get("target");
    const targetBindings = bodyObjectBindings(functionNode, target);
    const conversationId = targetBindings.get("conversationId");
    const hostId = targetBindings.get("hostId");
    if (scope == null || conversationId == null || hostId == null) return;

    walkWithAncestors(functionNode.body, (node, ancestors) => {
      if (node.type !== "CallExpression") return;
      const properties = objectExpressionProperties(node.arguments[0]);
      if (
        properties.get("scope")?.type !== "Identifier" ||
        properties.get("scope").name !== scope ||
        !properties.has("cwd") ||
        properties.get("hostId")?.type !== "Identifier" ||
        properties.get("hostId").name !== hostId
      ) {
        return;
      }

      const spread = ancestors.at(-1);
      const pushCall = ancestors.at(-2);
      const logical = ancestors.at(-3);
      if (
        spread?.type !== "SpreadElement" ||
        spread.argument !== node ||
        pushCall?.type !== "CallExpression" ||
        memberName(pushCall.callee) !== "push" ||
        logical?.type !== "LogicalExpression" ||
        logical.operator !== "&&" ||
        logical.right !== pushCall ||
        logical.left?.type !== "LogicalExpression" ||
        logical.left.operator !== "&&"
      ) {
        return;
      }

      const gitGate = logical.left.right;
      if (
        gitGate?.type !== "CallExpression" ||
        gitGate.callee?.type !== "MemberExpression" ||
        memberName(gitGate.callee) !== "get" ||
        gitGate.callee.object?.type !== "Identifier" ||
        gitGate.callee.object.name !== scope ||
        !gitGate.arguments.some(
          (argument) =>
            argument.type === "Identifier" && argument.name === conversationId,
        )
      ) {
        return;
      }

      contexts.push({
        logical,
        preservedCondition: logical.left.left,
        pushCall,
      });
    });
  });

  return contexts;
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

function patchSidebarSource(source) {
  if (source.includes(SIDEBAR_MARKER)) {
    return { status: "already-patched", source };
  }
  if (hasNativeDirectAction(source)) {
    return { status: "native", source };
  }

  let ast;
  try {
    ast = parse(source);
  } catch (error) {
    return { status: "parse-failed", phase: "before", error, source };
  }

  const contexts = findSidebarPatchContexts(ast, source);
  if (contexts.length !== 1) {
    return {
      status: "unexpected-sidebar-menu-gate-count",
      count: contexts.length,
      source,
    };
  }

  const [{ logical, preservedCondition, pushCall }] = contexts;
  const replacement =
    source.slice(preservedCondition.start, preservedCondition.end) +
    `&&${SIDEBAR_MARKER}` +
    source.slice(pushCall.start, pushCall.end);
  const next =
    source.slice(0, logical.start) + replacement + source.slice(logical.end);

  try {
    parse(next);
  } catch (error) {
    return { status: "parse-failed", phase: "after", error, source };
  }

  return { status: "patched", source: next };
}

function findTargets(platform) {
  const openMenuTargets = locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    ...(platform ? { platform } : {}),
  })
    .map((target) => ({
      ...target,
      source: fs.readFileSync(target.path, "utf-8"),
    }))
    .map((target) => ({ ...target, patchKind: "open-menu" }));
  const sidebarTargets = locateBundles({
    dir: "assets",
    pattern: /^app-primary-.*\.js$/,
    ...(platform ? { platform } : {}),
  })
    .map((target) => ({
      ...target,
      source: fs.readFileSync(target.path, "utf-8"),
    }))
    .map((target) => ({ ...target, patchKind: "sidebar" }));

  return [...openMenuTargets, ...sidebarTargets];
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
    const result =
      target.patchKind === "sidebar"
        ? patchSidebarSource(target.source)
        : patchSource(target.source);

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
        console.log(
          `  [?] ${label}: would expose the file manager action (${target.patchKind})`,
        );
      } else {
        fs.writeFileSync(target.path, result.source, "utf-8");
        console.log(
          `  [ok] ${label}: file manager action exposed (${target.patchKind})`,
        );
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
  SIDEBAR_MARKER,
  findTargets,
  hasNativeDirectAction,
  patchSidebarSource,
  patchSource,
};

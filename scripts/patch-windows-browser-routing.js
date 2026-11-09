#!/usr/bin/env node
/**
 * Windows 网页任务优先使用 Browser Use，避免通过原生窗口推断浏览器 URL。
 * 仅修正工具选择指引；原生窗口、网站策略和已终止回合的处理保持原样。
 */
const fs = require("node:fs");
const path = require("node:path");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "<!-- codex-windows-browser-routing -->";
const END = "<!-- /codex-windows-browser-routing -->";
const ROUTING = `${MARKER}
## Windows 浏览器任务入口

操作 Chrome、Edge 或内置浏览器的网页时，优先使用可用的 Browser Use / \`cua_repl\` 浏览器接口。\`sky.get_window_state()\` 和 \`cua.getApp()\` 属于原生窗口接口，不能替代浏览器标签页绑定与 URL 校验。浏览器原生文件选择器等桌面窗口仍适用本技能。

在浏览器工具的首次调用中，只执行它声明的一个初始化入口，并先阅读返回的接口说明。已知目标 URL 时按用户指定的浏览器调用 \`cua.createBrowserTab()\`；已有标签页使用 \`cua.getTab()\`；需要确认连接时使用 \`cua.getState()\`。不要把 Windows 窗口 ID 当作浏览器标签页 ID。

若浏览器通道不可用，报告具体连接或版本错误，并请用户连接对应扩展；不要自动回退到原生 Chrome 窗口读取。若已经返回 “Computer Use has been stopped for this turn”，本回合停止浏览器操作并说明原因，不能重置工具或改换接口继续同一操作。修复连接后，在下一回合使用浏览器入口。
${END}`;

const ROUTING_FILES = [
  { relative: "plugins/openai-bundled/plugins/computer-use/skills/computer-use/SKILL.md", kind: "skill" },
  { relative: "cua_node/bin/node_modules/@oai/cua-repl/instructions/windows/computer.md", kind: "computer" },
];

function patchSource(source, kind) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const block = ROUTING.replace(/\n/g, newline);
  let next = source;
  if (source.includes(MARKER)) {
    const start = source.indexOf(MARKER);
    const end = source.indexOf(END, start);
    if (end < 0 || source.indexOf(MARKER, start + MARKER.length) >= 0) {
      throw new Error("浏览器入口指引标记不完整或重复");
    }
    next = source.slice(0, start) + block + source.slice(end + END.length);
  } else if (kind === "skill") {
    const anchor = "## Initialize";
    if (!source.includes(anchor) || !source.includes('import("@oai/sky")')) {
      throw new Error("未知 Windows Computer Use 技能结构");
    }
    next = source.replace(anchor, `${block}${newline}${newline}${anchor}`);
  } else if (kind === "computer" && source.includes("cua.getApp(")) {
    next = `${block}${newline}${newline}${source}`;
  } else {
    throw new Error("未知 Windows Computer Use 入口结构");
  }
  if (kind === "skill") {
    const description = /^description: [^\r\n]+/m;
    if (!description.test(next)) throw new Error("Windows 技能缺少 description");
    next = next.replace(description,
      "description: 控制 Windows 原生桌面应用和原生对话框；网页任务优先使用 Browser Use 浏览器接口");
  }
  return { source: next, changed: next !== source };
}

function planRouting(resourcesRoot) {
  return ROUTING_FILES.map(({ relative, kind }) => {
    const file = path.join(resourcesRoot, relative);
    return { file, ...patchSource(fs.readFileSync(file, "utf8"), kind) };
  });
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => ["win", "mac-arm64", "mac-x64"].includes(arg));
  if (platform && platform !== "win") return;
  const root = path.join(SRC_DIR, "win");
  if (!fs.existsSync(root) && !platform) return;
  const plan = planRouting(root);
  for (const item of plan) {
    if (item.changed && !args.includes("--check")) fs.writeFileSync(item.file, item.source);
    const status = item.changed ? (args.includes("--check") ? "browser routing patch required" : "browser routing updated") : "already patched";
    console.log(`[${item.changed ? "*" : "ok"}] ${relPath(item.file)}: ${status}`);
  }
}

if (require.main === module) main();
module.exports = { MARKER, ROUTING_FILES, patchSource, planRouting };

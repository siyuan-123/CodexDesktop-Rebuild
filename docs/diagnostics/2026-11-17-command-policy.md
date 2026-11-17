# Windows 命令执行拒绝的源码诊断

核查日期：2026-11-17，Asia/Taipei。

## 结论

现场命令在 PowerShell 创建前被本地命令策略拒绝。触发原因是同一段 PowerShell 中同时出现 `Start-Process` 和用于输出健康检查地址的 URL；复杂语法无法降为独立命令后，旧版分类器扫描整段脚本的词元，将二者关联为网址启动。`approval_policy = "never"` 随后将需要审批的分类结果变为拒绝。

这次拒绝没有进入自动审批模型。此前会话中“自动审批拒绝”的表述不准确，`danger-full-access` 也没有关闭命令分类检查。

## 现场证据

| 项目 | 核查结果 |
| --- | --- |
| 实际运行桌面版本 | `26.1016.51333`，运行目录为 `out-browser-auth/win/Codex-win32-x64` |
| 实际运行 CLI | `0.163.0-alpha.11` |
| 仓库原有生成资源 | 桌面 `26.1103.32239`，不是现场运行包 |
| 回合实际权限 | 桌面日志 `resolvedApprovalPolicy=never`、`resolvedApprovalsReviewer=user`；CLI 诊断日志 `approval_policy=Never sandbox_policy=DangerFullAccess` |
| 第一次拒绝 | 2026-11-17 18:46:03，调用编号 `call_jfTX3ibJA4Wrf7ML0pyTpZfS` |
| 第二次拒绝 | 2026-11-17 18:47:30，调用编号 `call_XCXwfUkbA1DZGYfXKdxinekv` |
| 原始错误形态 | `exec_command failed: CreateProcess { message: "Rejected(... rejected: blocked by policy)" }` |
| 进程执行情况 | 工具报告 `Wall time 0.0 seconds`；`CreateProcess` 在此处是统一执行器的错误包装，不是 Java 的退出结果 |

先经桌面聊天接口定位相关回合，再对照该回合的两条原始工具错误与本地诊断日志。记录不包含认证配置、请求头、令牌和不相关会话内容。

## 桌面端与 CLI 的调用链

1. 实际运行 ASAR 的 `.vite/build/src-CsH31EEu.js:689` 组装 `turn/start` 参数并记录解析后的权限。已有回合传入 `null` 表示继承会话设置，不表示切到自动审批。
2. 同文件 `Sw` 函数中的 `auto_review` 覆盖只在 `isAeon && isDurable` 分支使用；现场是本机会话，桌面日志和 CLI 日志均确认另一组权限。
3. [`unified_exec/process_manager.rs`](https://github.com/openai/codex/blob/5425d3e625daa58eea3ad1de27c087eb3b2ffbd3/codex-rs/core/src/unified_exec/process_manager.rs#L1511) 在启动前调用 `create_exec_approval_requirement_for_shell`。
4. [`exec_policy.rs`](https://github.com/openai/codex/blob/5425d3e625daa58eea3ad1de27c087eb3b2ffbd3/codex-rs/core/src/exec_policy.rs#L875) 尝试解析 PowerShell；含变量赋值、哈希表等动态结构时保留整个 shell 命令。
5. [`windows_dangerous_commands.rs`](https://github.com/openai/codex/blob/5425d3e625daa58eea3ad1de27c087eb3b2ffbd3/codex-rs/shell-command/src/command_safety/windows_dangerous_commands.rs#L21) 对该命令做 `shlex` 扁平扫描。`has_url` 与 `Start-Process` 的存在分别检查，未确认 URL 是否是该启动命令的参数。
6. [`exec_policy.rs:799`](https://github.com/openai/codex/blob/5425d3e625daa58eea3ad1de27c087eb3b2ffbd3/codex-rs/core/src/exec_policy.rs#L799) 将命中的危险分类和 `AskForApproval::Never` 组合为 `Decision::Forbidden`；`DangerousCommandMatch::Other` 仅返回通用文案。
7. [`tools/orchestrator.rs:201`](https://github.com/openai/codex/blob/5425d3e625daa58eea3ad1de27c087eb3b2ffbd3/codex-rs/core/src/tools/orchestrator.rs#L201) 将 `Forbidden` 直接转为 `ToolError::Rejected`，不会执行后续的审批请求分支。统一进程管理器再包装为 `CreateProcess` 错误。

`scripts/codex-binary-policy.js` 管理运行时来源，不负责上述命令策略。

## 最新源码对照

| 源码版本 | 固定提交 | 现场命令的静态分类 |
| --- | --- | --- |
| `0.163.0-alpha.11` | `5425d3e625daa58eea3ad1de27c087eb3b2ffbd3` | 解析回退，命中危险分类 |
| 最新稳定版 `0.169.0` | `d32063f96c2dff1dc96af839b3952abb6acfeda4` | 解析回退，命中危险分类 |
| 最新桌面包配套 CLI `0.169.0-alpha.11.1` | `226fa88979b1a9d76dc36f339ee9c5fbdb2c8e7f` | 分类器与已验证的 `0.169.0` 完全一致 |
| 2026-11-17 的 `main` | `59ac39addbbcd3499319c805a916846ca8ac5fef` | 解析回退，命中危险分类 |

新版加入 `powershell_commands_are_independent` 和 `PowerShellLiteral`，对可严格解析且互不依赖的字面量命令分别分类。存在管道、变量等复杂语法的现场命令仍使用旧路径，因此不能宣称升级已经修复这一输入。

静态验证直接编译以上版本的原始 `windows_dangerous_commands.rs` 与 PowerShell 解析模块，未执行任何样例命令。五类样例覆盖现场文本、本地进程启动、混合 URL 数据输出、真实网址启动和单独 URL 数据输出。旧版与最新主分支各 42 项上游模块测试通过。

## 已完成的改动及范围

- `scripts/windows-runtime-compatibility.js` 在 Windows 打包清理输出前，检查补丁源和 MSIX 缓存的桌面版本、构建号，以及 CLI、code-mode host、命令运行器和沙箱组件的 SHA-256；发现混用就明确中止。旧版不存在的可选组件允许双边缺省。
- `patches/codex/0001-explain-command-policy-rejection.patch` 为 CLI 的启发式拒绝补充“命令检查需要审批，而 never 禁用了审批提示”的原因。它保留拒绝结果，避免把本地分类拒绝误称为自动审批模型拒绝。
- 诊断补丁已对上述四个源码快照通过 `git apply --check`，从实际修改后的源码提取的错误格式化函数通过 2 项测试。尚未编译和替换整套 CLI，因此该文案补丁不属于桌面发布包中的已部署改动。

Windows 配套构建的发布验证另见[升级记录](2026-11-17-windows-runtime.md)。全局强制放行不在本次实现中；上述诊断补丁也不改变网址启动、命令审批或沙箱的决定。

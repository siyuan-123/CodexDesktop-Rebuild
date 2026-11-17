# Windows 最新配套运行时验证

核查与构建日期：2026-11-17，Asia/Taipei。

## 产物与版本

此次生成的是配套运行时的兼容性验证包。已完成下载、解包、补丁、打包与本地协议验证；没有替换正在运行的桌面程序，旧版全部功能增强也没有完成迁移。

| 项目 | 值 |
| --- | --- |
| 上游 Windows MSIX | `26.1111.2228.0`，x64 |
| ASAR 桌面版本 | `26.1111.21308` |
| 桌面构建号 | `27194` |
| 同包 CLI | `0.169.0-alpha.11.1` |
| CLI 官方源码 | [`226fa88979b1a9d76dc36f339ee9c5fbdb2c8e7f`](https://github.com/openai/codex/tree/226fa88979b1a9d76dc36f339ee9c5fbdb2c8e7f) |
| 独立构建目录 | `D:\CodexBuilds\CodexDesktop-Rebuild-20261117` |
| 便携目录 | `out-latest\win\Codex-win32-x64` |
| 压缩包 | `out-latest\Codex-win-x64-26.1111.21308.zip` |
| 压缩包大小 | `1,035,725,131` 字节（约 987.7 MiB） |
| 压缩包 SHA-256 | `2059bc099ec01261dabb145f7cddd3771813e05a950ef52e6eb5577c747a0adf` |

`scripts/check-update.js` 返回的当前 Windows 包经原有 `sync-upstream.js` 下载，并验证 MSIX 架构与版本。构建使用同包的桌面资源、CLI、code-mode host、命令运行器及 Windows 沙箱组件，没有单独替换成 GitHub 的另一版 CLI。C、E 盘空间不足，因此下载、解包和产物均放在 D 盘；仓库中的可维护改动仍保留在 `E:\PY\CodexDesktop-Rebuild`。

## 已验证的边界

- 构建前核对源资源与 MSIX 缓存的版本、构建号及 5 个运行时二进制的 SHA-256；构建后再次核对产物中的版本和二进制。
- `codexWindowsAppContainedCore=0`，让便携包使用同包运行时；`ChatGPT.exe` 与 `Codex.exe` 的内嵌 ASAR 哈希均与新 `app.asar` 一致。
- 在独立空白测试配置目录中启动产物的 `app-server`，完成 `initialize`、`initialized`、`configRequirements/read`，关闭标准输入后正常退出，退出码为 0。没有发起模型回合。
- 仓库 166 项测试通过，其中新增版本配套测试 7 项。没有验证登录后的桌面交互或既有会话迁移。
- ZIP 内 4,430 个条目全部通过 CRC 校验，便携启动器、ASAR、CLI 和 code-mode host 均存在。
- 命令拒绝的说明补丁仅作为源码补丁交付，未编译进此包；现场命令的分类结果依然为拒绝，详见[源码诊断](2026-11-17-command-policy.md)。

## 补丁生效范围

27 个现有脚本的 `--check` 预检均以 0 退出，但这不代表每项功能已适配。新版采用 Rspack 的编号资源块，多项历史脚本未找到匹配目标。

本次实际运行以下 13 个脚本，运行记录保存在构建目录的 `upstream-cache/applied-patches.json`：

```text
patch-reasoning-effort-labels.js
patch-codex-home-env.js
patch-windows-portable-runtime.js
patch-browser-auth.js
patch-windows-browser-routing.js
patch-updater.js
patch-crash-forensics.js
patch-worker-forensics.js
patch-worker-limits.js
patch-diff-limits.js
patch-git-output-cap.js
patch-sentry-scope.js
patch-cdp-screenshot.js
```

其中浏览器请求头读取与 Sentry 限制已由上游原生实现，脚本只确认兼容，没有重复修改。此次未运行插件身份检查和功能开关放行补丁，也没有改写命令审批或 URL 决策。

预检中未命中的历史功能包括语言开关、快速模式、语音认证、模型列表筛选与子菜单、会话文件管理器入口、复制 Markdown、工作区根目录入口和归档删除按钮。因此本产物不标记为原定制版的完整替代品。

## 可复核记录

构建目录的 `upstream-cache` 下保留：

| 文件 | 内容 |
| --- | --- |
| `sync-latest.log` | 下载、MSIX 身份校验和资源同步 |
| `patch-check.log` | 27 项预检及未匹配项 |
| `patch-apply.log` | 实际应用的补丁 |
| `patch-recheck.log` | 已应用补丁的再次检查 |
| `repository-tests.log` | 166 项仓库测试结果 |
| `build-latest.log` | 配套校验、ASAR 打包及 ZIP 输出 |
| `package-verification.json` | 运行时 SHA-256、版本及 ASAR 完整性 |
| `appserver-smoke-result.json` | 本地协议初始化结果 |
| `archive-verification.json` | ZIP 文件数、CRC 与 SHA-256 |

这套验证证明版本配套和本地协议启动正常，不意味着 `blocked by policy` 已被解除。

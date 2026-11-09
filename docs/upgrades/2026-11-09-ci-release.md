# GitHub 自动构建与浏览器修复发布（2026-11-09）

## 构建阻塞及修复

远端 `master` 原先停在 `fb55f67`。近期同步发布工作流失败在 `patch-reasoning-effort-labels` 和 `patch-remote-control`：新版 Rspack 将前端改为 `assets/async/<数字>.<hash>.js`，旧扫描只处理 `assets` 根目录中的命名文件。

- 增加不跟随符号链接的递归 JavaScript 枚举，仅用于本次适配的中文语言包与远程连接补丁。
- 中文语言包依据 `../locales/zh-CN.json` 的真实导入映射定位数字分片，避免根据翻译文字猜测语言；兼容 `JSON.parse` 字符串载荷，保留其他翻译及旧模板字符串语言包。
- 远程连接补丁识别 Rspack 的 `(0, module.export)(gateId)` 调用；服务端能力状态、认证要求与其他 gate 保持原样。
- 两条 Windows 工作流在下载上游并应用补丁后执行浏览器运行时测试，覆盖真实 `networkPolicy` 读取和传递行为。

浏览器路由、运行时同步脚本和原安装实测说明见 [浏览器修复记录](2026-11-09-browser-fix.md)。本次没有迁移所有历史界面增强；依赖旧前端名称或结构的模型子菜单、会话菜单、复制 Markdown 等补丁继续使用原有识别规则，不能把构建完成视为这些功能已在新版界面验证。

## 本地验证

- Windows 上游 MSIX：`26.1103.4239.0`，x64；内部桌面版本：`26.1103.32239`。
- `npm test`：159 项通过，0 项失败，包含真实 Windows 浏览器运行时策略测试。
- 新增回归覆盖嵌套分片、locale 映射选择、JSON 载荷转义与幂等，以及 Rspack 导入调用和服务端能力保留。
- 正式应用补丁后再次执行检查：27/27 脚本成功，无待修改项。
- 完整 Windows ZIP：`Codex-win-x64-26.1103.32239.zip`，1,039,196,844 字节（991.1 MiB）；全部 4,431 个文件通过 CRC 和构建目录逐文件 SHA-256 对比。
- ZIP SHA-256：`0b5c9ce91c974aa1990e198f4fe335e01b421c982b94ebd686220b26967d4c28`。
- 包内四处浏览器运行时与源码一致，两份调用指引均包含修复；中文语言包已打入 ASAR。启动程序的 ASAR 校验值正确，CLI / code-mode host / command runner 与同版本上游一致；CLI 启动返回 `0.167.0-alpha.3.2`。
- 本次未启动新的桌面主进程，不把文件验证当作新版界面实测。

## GitHub Actions 状态

修复已推送至 `master`：`a9ee4f2`（浏览器修复）和 `08e9866`（Rspack 构建适配）。GitHub 拒绝启动工作流，返回 `HTTP 422: Actions has been disabled for this repository`，推送也没有产生新的运行记录。

仓库 API 返回 `enabled: true`，两条工作流均为 `active`。重新启用工作流和重新写入仓库 `enabled: true` 后，手动触发仍得到相同拒绝；没有证据确定是账户、账单还是 GitHub 平台限制。本次完整 Windows 包由本机构建并验证，云端自动构建需要 GitHub 侧恢复运行权限。

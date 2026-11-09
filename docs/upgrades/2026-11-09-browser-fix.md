# Windows 浏览器调用修复（2026-11-09）

## 原因

原始失败调用为 `sky.get_window()` / `sky.get_window_state()`，目标是 Chrome。Windows 原生 helper 无法可靠确认当前 URL，返回 `could not determine the current browser URL on Windows with enough confidence to enforce policy`，终止当回合。该消息并不表示已经判断目标网站被禁止。

浏览器扩展可以返回完整的标签页 URL，但旧运行时还存在协议不匹配：当前桌面端为 `26.1016.51333`，Chrome 扩展为 `1.26.1102.11740`。旧版 `attach` 只发送 `tabId`；扩展现在读取 `networkPolicy.timeoutMs` 与 `networkPolicy.constraints`，因缺少 `networkPolicy` 而抛出空对象访问错误。

仓库 `src/win` 中的 `26.1027.30824` 浏览器运行时已具备 `getNetworkPolicy()` → `readNetworkPolicy()` → `attach(tabId, networkPolicy)` 链路，会读取托管要求、用户配置及已保存的站点拒绝设置。

## 修复范围

- `patch-windows-browser-routing.js` 更新 Windows Computer Use 技能和工具入口说明：网页优先使用 Browser Use，原生对话框继续使用原生窗口接口；保留已终止回合的停止要求。
- `repair-browser-runtime.js` 成套同步浏览器客户端、服务端与 WASM，覆盖外置运行时和可选插件缓存；预检网络策略链路及 JavaScript 语法，写入前保存原件和哈希，失败回滚。
- 未修改原生 helper 二进制、CLI、浏览器扩展、用户配置或策略判断。

## 验证

使用原安装目录的桌面主进程及已连接 Chrome 扩展，更新 Browser Use 运行时并重建工具会话后，Chrome 和内置浏览器均成功打开测试页并读取完整 URL 和可访问性树；更新前 Chrome 的相同调用返回 `timeoutMs` 错误。测试标签页已关闭，用户原有标签页保留。

回归测试覆盖只读检查、四份入口成套同步、备份、幂等、资源缺失、写入中断回滚、并发修改检测和缓存范围；直接执行真实生成运行时的方法，确认策略原样传递且策略读取失败时不执行 `attach`。

`npm test`：155 项通过，0 项失败。Windows 技能通过 `quick_validate.py`，安装目录与插件缓存再次检查为 0 个待更新文件。

原生 helper 的 URL 推断算法未修复，也未声称支持所有 Windows 浏览器窗口。网页操作的修复路径是扩展/内置浏览器提供的标签页通道。已加载旧技能或旧运行时的其他会话需要在下一回合重新初始化工具，或重启 Codex。默认网页入口与官方 [Browser 文档](https://learn.chatgpt.com/docs/browser) 一致。

## 完整 Windows x64 包

已基于匹配的 `26.1027.30824` 源码和上游 x64 缓存，生成独立的完整便携包：

`out-browser-fix-20261109/Codex-win-x64-26.1027.30824.zip`

- 大小：983,367,986 字节（937.8 MiB）。
- SHA-256：`a34bfac838c7f22bbf8ea04a55a3d8addc59f2cb94cc5a25e082456dd1a430aa`，同目录附有 `.zip.sha256` 文件。
- `patch-all.js win --check`：27/27 项检查通过，无待应用补丁。
- 四处浏览器运行时与源码一致，网络策略链路预检通过；两份浏览器调用指引均已进入包中。
- 两个桌面启动程序的 ASAR 校验值与重新打包的 `app.asar` 一致；CLI、code-mode host 和 command runner 与同版本上游缓存一致。CLI 启动返回 `0.166.0-alpha.5.1`。
- ZIP 内全部 4,335 个文件通过 CRC 检查，并逐个校验 SHA-256 与构建目录一致。

完整校验记录位于输出目录的 `runtime-verification.json`、`zip-verification.json`、`patch-check.log` 和 `build.log`。本次构建没有启动新的桌面主进程；前述 Chrome / 内置浏览器实测使用的是已修复的原安装实例。

使用时退出旧版，将 ZIP 完整解压到新目录，然后运行其中的 `Codex.exe`。本机构建目录中也已保留可直接运行的 `out-browser-fix-20261109/win/Codex-win32-x64/Codex.exe`。

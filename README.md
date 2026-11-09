# Codex Desktop Rebuild

Cross-platform Electron build for OpenAI Codex Desktop App.

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | x64, arm64   | ✅     |
| Windows  | x64          | ✅     |
| Linux    | x64, arm64   | ✅     |

## Build

```bash
# Install dependencies
npm install

# Sync upstream resources, then apply all patches
npm run sync
npm run patch

# Build for current platform
npm run build

# Build for specific platform
npm run build:mac-x64
npm run build:mac-arm64
npm run build:win-x64
npm run build:linux-x64
npm run build:linux-arm64

# Build all platforms
npm run build:all
```

## 补丁链路

- `src/<platform>/_asar` 是 ASAR 内资源的补丁目标。
- `src/<platform>/plugins` 与 `src/<platform>/cua_node` 是 Browser / Computer Use 等外置运行时的补丁目标；直打包流程会显式覆盖这两个目录，避免重新复制上游安装包缓存时丢失补丁。
- `patch-browser-auth.js` 兼容 API-key 登录：ChatGPT 身份与 request-header 策略可用时保持原行为；身份读取失败时仅关闭该可选请求头并继续本地浏览器通道，不会把 API key 伪装或发送为 ChatGPT token。
- `patch-windows-browser-routing.js` 在 Windows 技能及工具入口中区分网页与原生窗口：网页优先使用 Browser Use，避免通过 `sky.get_window_state()` 推断 URL；已终止的浏览器回合仍停止操作。
- `patch-image-generation-auth.js` 兼容自定义 `base_url` 的 API-key 登录：仅对非 OpenAI/ChatGPT 官方地址为 app-server 注入 provider 认证、`image_gen` 能力参数，并在没有静态模型目录时启用远端模型发现；显式关闭项及已有 `model_catalog_json`/`model_catalog_url` 均优先，API key 只经子进程环境传递，不写入用户配置或命令行。
- `patch-realtime-voice-auth.js` 为 API-key 登录放行实时语音入口；实时会话仍由 app-server 使用当前 model provider 的 `base_url` 与认证创建，ChatGPT 工作区能力的认证限制保持不变。
- 上游更新后应先执行 `npm run patch -- --check` 或完整 `npm run patch`，再运行测试和构建。

### Windows 26.1016.51333 兼容性

- Fast mode 同时覆盖旧权限函数、新版 `readServiceTier` 与界面 `serviceTierAccess` 权限入口，保留加载状态及 `fast_mode = false` 的限制，避免把首页提示里的产品类型判断误当成认证。
- 模型目录兼容新版访问计划分支；模型选择器已原生支持点击切换完整列表，补丁会明确识别并保留该实现。
- 侧边栏“复制为 Markdown”会先加载完整会话历史；未挂载会话页面时使用后台完整快照和原生渲染器，空内容、历史不完整或剪贴板失败会显示原生错误提示。
- 普通目录会话的文件管理器入口兼容新版远程连接 selector，仍保留工作目录与远程连接条件。顶层入口复用工作区原生打开回调，避免侧边栏缺少任务作用域时点击无响应；保留工作树路径解析及失败提示，单次打开不改变默认编辑器。
- Browser/CUA 的四份 `browser-service.mjs` 均逐份检查；新版从 `configRequirements` 读取托管请求头，保留原生策略及读取错误。
- Windows 构建通过 Node 直接执行 npm CLI，修复新版 Node 下 `npm.cmd` 的 `EINVAL`。`patch-updater --check` 只检查，不修改文件。
- 微软商店返回多个 x64 包时按数值版本选择；空链接会重试，摘要不匹配时失败。版本检测任一平台失败会输出 `errors` 并返回退出码 `2`，不会保存不完整的成功状态。

Windows 本地升级可按以下顺序执行；当前程序运行时使用新的输出目录：

```powershell
npm run sync -- --skip-mac
npm run patch -- win --check
npm run patch -- win
npm test
$env:CODEX_OUT_DIR = 'out-upgrade'
npm run build
```

检查模式用于判断补丁是否兼容；正式应用后应再次运行检查，确认无待修改项。新版 CLI 与桌面端保持同包，不单独替换 CLI。此次 Windows 升级记录见 [2026-10-21 验证记录](docs/upgrades/2026-10-21.md)，后续修复见 [资源管理器修复记录](docs/upgrades/2026-10-21-explorer-fix.md)；最新菜单修复包与实测范围见 [菜单专项回归记录](docs/upgrades/2026-10-21-menu-audit.md)。

### Windows 浏览器 URL 识别及扩展版本兼容

`could not determine the current browser URL on Windows` 来自原生 Computer Use helper。网页任务应从 `@Chrome` / `@Browser` 的 Browser Use 接口开始；普通 Windows 窗口句柄不是浏览器标签页句柄。已停止的回合需要结束，修复后在下一回合重新开始。

Chrome 扩展 `1.26.1102.11740` 的 `attach` 请求要求 `networkPolicy`。旧桌面运行时 `26.1016.51333` 未传该字段，会出现 `Cannot read properties of undefined (reading 'timeoutMs')`。已生成的 `26.1027.30824` 浏览器运行时包含完整的策略读取与传递链路。可将其同步到现有安装目录，保留桌面端和 CLI：

```powershell
node scripts/repair-browser-runtime.js --resources 'E:\path\Codex\resources' --codex-home 'C:\Users\me\.codex' --check
node scripts/repair-browser-runtime.js --resources 'E:\path\Codex\resources' --codex-home 'C:\Users\me\.codex'
```

脚本使用 `src/win`，也可通过 `--source` 指定已同步的 Windows 资源。客户端、服务端和 WASM 成套更新，检查四个运行时入口，并同步可选 Codex home 下已安装的 browser/chrome 缓存及 Windows 技能。全部文件预检通过后才写入；备份和 SHA-256 清单位于安装目录的 `browser-runtime-backups`，写入失败会回滚。它不修改 URL 策略或浏览器扩展。更新后重启 Codex，或在新回合重建浏览器工具会话。实测范围见 [2026-11-09 浏览器修复记录](docs/upgrades/2026-11-09-browser-fix.md)。

## Development

```bash
npm run dev
```

## Project Structure

```
├── src/
│   └── <platform>/
│       ├── _asar/       # Extracted app.asar patch target
│       ├── plugins/     # Bundled plugin patch target
│       └── cua_node/    # Browser / Computer Use runtime patch target
├── resources/
│   ├── electron.icns    # App icon
│   └── notification.wav # Sound
├── scripts/
│   ├── patch-all.js
│   └── patch-browser-auth.js
├── forge.config.js      # Electron Forge config
└── package.json
```

## CI/CD

### 26.1027 构建与补丁兼容性

26.1027 将主进程切分为 `early-bootstrap-<编号>-<hash>.js`。版权、开发者工具、worker 内存保护、CDP 截图和 Git 输出限制按内容逐平台定位，覆盖共享 chunk；目标缺失会中止构建。`CODEX_HOME` 初始化兼容匿名启动函数，diff 的 8MB 限额兼容内联常量，同时保留调用方更小的限额。

更新器策略兼容箭头函数，覆盖 macOS、Windows 和 Linux；插件补丁去重重叠遍历产生的同位置替换并在写入前检查语法。Sentry 按同一平台的多个 chunk 识别上游已有的 breadcrumb 截断和 scope 文件保护。独立 Git worker 使用 Electron 的 `--js-flags=--max-old-space-size=1024`，其他 worker 继续通过 `resourceLimits` 限制内存。

`npm test` 包含拆分 chunk、匿名函数、转义 HTML、更新器、截图参数、内存限额、只读检查及重复应用的回归测试。问题分析与真实包验证见 [2026-10-31 构建修复记录](docs/upgrades/2026-10-31-build-fix.md)。

26.1021 上游将工作区与侧边栏菜单移至 `app-primary`；文件管理器补丁按菜单内容在 `app-initial` / `app-primary` 中逐平台定位，不再依赖远程连接配置名。补丁仍保留工作目录和远程连接条件、原生打开回调与错误提示；未知菜单结构会明确报错。

构建兼容新版上游资源布局：macOS 保留 `codex-cli/CodexCLI.app` 内的同包 CLI；Linux 同时识别 npm 平台包的新旧目录，并安装匹配架构的 CLI、`rg`、code-mode host 与沙箱资源。缺少必要资源时立即失败，不再保留不能在 Linux 运行的 macOS 二进制。

Linux x64 / ARM64 分别在对应架构的 runner 上编译原生模块，打包后实际执行 CLI、`rg` 和 `bwrap` 的版本检查。手动构建在各平台执行回归测试。

GitHub Actions automatically builds on:
- Push to `master` / `main` and tag `v*` → build artifacts
- 每日上游同步工作流：逐平台比较已保存的版本；仅在任一平台版本变化时下载上游、重新应用补丁、构建并更新 Release

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild & Linux [@cometix/codex](https://www.npmjs.com/package/@cometix/codex) binaries
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.

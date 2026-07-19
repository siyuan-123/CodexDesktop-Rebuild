# Statsig 云控映射表

> 通过 AST 分析 `index-MmO6ZWIv.js` 提取，ID 为 Statsig DJB2 哈希值（`(hash << 5) - hash + charCode`），原始名称仅存于服务端。

## Feature Gates (30)

| ID | 功能 | 组件/函数 | 说明 |
|---|---|---|---|
| `505458` | Composer Mode | `Pvn` / `Vvn` | 控制 composer 模式选项（code/ask 等） |
| `30039772` | `enable_request_compression` | `HUn` | 请求压缩 |
| `98625937` | 账户设置面板 A | `GNe` | 用户设置/认证下拉菜单 |
| `351086149` | *(server-only)* | — | 客户端未引用 |
| `351460523` | Follow-up 排队 | `Iwn` | 自动跟进建议 |
| `1060282072` | 协作模式 UI | `mae` / `NRn` / `jjn` | 协作模式相关组件 |
| `1156958996` | `collaboration_modes` | `HUn` | 协作模式功能开关 |
| `1221508807` | Archive Thread | `ef` | 归档会话线程 |
| `1230000863` | *(server-only)* | — | 客户端未引用 |
| `1444479692` | `personality` | `LZe` / `HUn` | 个性化/人格 |
| `1609556872` | Hotkey 窗口 | `jxn` | 快捷键窗口功能 |
| `1823130936` | Image Input | `ICn` | 判断模型是否支持图片输入 |
| `1846562237` | Onboarding 登录 | `TFn` | 登录流程/resume 控制 |
| `2239678350` | *(server-only)* | — | |
| `2313552244` | *(server-only)* | — | |
| `2451719447` | *(server-only)* | — | |
| `2761175068` | Feature Rollout 守卫 | `PXe` | 通用 gate 包裹组件 |
| `2777274066` | *(server-only)* | — | |
| `2878153158` | *(server-only)* | — | |
| `2882842607` | 会话 Diff/评论 | `Uae` | 对话中的代码 diff 和评论 |
| `2968710568` | *(server-only)* | — | |
| `3075919032` | 主界面布局 | `iUt` | 拖拽/面板布局 |
| `3189729426` | *(server-only)* | — | |
| `3227700559` | ChatGPT 认证流 | `QBn` | ChatGPT auth 方式检测 |
| `3390468622` | `request_rule` | `HUn` | 请求规则 |
| `3798472673` | *(server-only)* | — | |
| `4059535852` | *(server-only)* | — | |
| `4100906017` | 语音输入/听写 | `Gxn` | dictation 功能 |
| `4166894088` | 账户设置面板 B | `GNe` | 与 `98625937` 同函数 |
| `4276547895` | *(server-only)* | — | |
| **`2929582856`** | **App Sunset 强制更新** | **`aUn`** | **全屏遮罩阻止使用，需 patch** |

### HUn 注册表中的 featureKey 映射

```
gate 30039772   → enable_request_compression
gate 1786883712 → unified_exec
gate 1615536597 → shell_snapshot
gate 770526561  → remote_models
gate 2828273915 → responses_websockets
gate 2734851136 → responses_websockets_v2
gate 1156958996 → collaboration_modes
gate 1444479692 → personality
gate 3390468622 → request_rule
gate 2357796820 → apps
gate 2911102190 → sqlite
gate 2307253562 → codex_git_commit
```

> 注：以上 12 个 gate 在 HUn 中注册但部分未出现在实际下发的 30 个 gate 列表中，说明服务端仅下发与当前用户匹配的 gate 子集。

## Dynamic Configs (15)

| ID | 功能 | 组件/函数 | 说明 |
|---|---|---|---|
| `107580212` | 模型配置 | `ZEe` | 获取可用模型列表 |
| `1121645430` | A/B 实验分组 | `zge` | 获取 experiment group name |
| `3210878109` | Personality 配置 | `LZe` | 获取个性化设置参数 |
| 其余 12 个 | *(server-only)* | — | 客户端未直接引用 |

## Layers (6)

| ID | 功能 | 组件/函数 | 说明 |
|---|---|---|---|
| `72216192` | i18n 配置层 | `jjt` / `Xkn` / `tWn` | `enable_i18n`、`locale_source` 等参数 |
| `745800994` | WebSocket 特性层 | `HUn` | `responses_websockets` 相关 |
| `3902942138` | Git Commit 特性层 | `HUn` | `codex_git_commit` 相关 |
| 其余 3 个 | *(server-only)* | — | |

## Patch 脚本

| 脚本 | 目标 | 策略 |
|---|---|---|
| `patch-sunset.js` | gate `2929582856` | `Cs(i)` → `!1`，短路 sunset 守卫 |
| `patch-statsig-logger.js` | `_setStatus()` | 注入日志，打印所有 gates/configs/layers 值 |
| `patch-i18n.js` | `qNe()` | 注入 `en-US` 到语言选择器列表 |
| `patch-devtools.js` | `allowInspectElement` / `devTools` | 属性值 → `!0` |
| `patch-copyright.js` | About Dialog / setAboutPanelOptions | 替换版权文本 |
| `patch-process-polyfill.js` | Windows `process` polyfill | 注入 `process.env`/`process.platform` |
| `patch-remote-control.js` | gate `4114442250` / `1042620455` | 开启 Connections 入口与 Remote Control 数据加载；保留服务端权限状态判断 |

### Remote Control 已确认 gate

| ID | 功能 | 影响范围 |
|---|---|---|
| `4114442250` | Remote Connections 可见性 | Settings 中的 Connections 项、相关远程标识 |
| `1042620455` | Remote Control / Slingshot | 手机控制分区、远程设备加载、主进程 gate bridge |

## 备注

- Statsig DJB2 算法：`(hash << 5) - hash + charCode`，结果 `>>> 0` 转无符号
- 哈希输入为服务端 gate/config/layer 的原始名称，客户端不保存原始名称
- 所有 gate 在非登录/无网络状态下默认 `FALSE`
- `2929582856` (sunset) 不在常规 30 个 gate 下发列表中，可能通过延迟加载或特定条件触发

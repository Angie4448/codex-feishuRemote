# Codex ↔ 飞书同会话同步

基于 [GavinYangAI/Comote](https://github.com/GavinYangAI/Comote) **0.7.2** 的 Windows 定制版：在手机飞书私聊机器人，继续电脑 Codex 桌面端中已经打开的同一个本地会话。

这是独立衍生项目，保留上游 MIT 许可证及作者署名；不是 OpenAI 或飞书官方产品。首版覆盖 Windows + 飞书。仓库中的其他 IM 渠道和部分界面来自上游，尚未在此定制版中逐项验证。

## 工作方式

```text
手机飞书 ⇄ 飞书机器人长连接 ⇄ 本机同步服务 ⇄ Codex 桌面 IPC ⇄ 已绑定会话
```

- 手机只连接飞书；电脑需要能访问飞书及 Codex 所需服务，并保持登录、联网和桌面应用运行。
- 手机普通消息进入指定桌面会话。桌面的助手进度文字和最终答复会转发回飞书。
- 复用桌面会话的模型和权限设置；电脑处理任务时，手机消息排队，队列最多 20 条。
- 首次连接不全量推送旧聊天记录。工具轨迹仍主要在电脑查看。
- 新发送者必须在本机管理页确认身份。需要桌面审批的操作须回电脑处理，不会自动批准。
- 不包含上下文百分比提醒、周期唤醒模型、自动换会话或自动交接。

## 安装前提

1. Windows、Node.js 22 或更新版本、PowerShell。
2. 已登录的 Codex 桌面应用，以及一个已经打开的本地会话。
3. 该会话的真实 `threadId`（UUID，可从本机 Codex 会话元数据取得；不是公开分享链接）。
4. 可使用的飞书账号和机器人权限。配置采用上游的扫码绑定流程。

本连接器使用非公开、实验性的桌面 IPC **v11**。原部署在桌面版本 **26.1013.4894** 上验证；更新桌面应用后可能需要适配。不支持把任意 ChatGPT 网页聊天 ID 当作本地会话 ID。

## 安装与启动

```powershell
git clone https://github.com/Angie4448/codex-feishuRemote.git
cd codex-feishuRemote
npm ci --ignore-scripts
npm test
```

在 PowerShell 中启动，替换下面的占位内容：

```powershell
.\Start-Sync.ps1 -ThreadId '<你的本地会话UUID>'
.\Open-Settings.ps1
```

若 Windows 提示脚本执行被禁用，可先运行 `Set-ExecutionPolicy -Scope Process Bypass`；此设置仅对当前 PowerShell 窗口有效，不修改系统长期策略。

`Start-Sync.ps1` 使用独立的本机数据目录，默认端口为 `16208`。已有服务占用端口时会拒绝启动。并行测试请为新实例指定不同的 `-DataDirectory` 和 `-Port`，并使用另一个机器人，避免同一机器人被多个服务消费消息。

默认数据目录为 `%LOCALAPPDATA%\codex-feishuRemote`，启动后会在其中保存 `local-settings.json`。同一数据目录下再次启动可省略 `-ThreadId`；配置、凭据和消息不应复制回仓库。`-ValidateOnly -ThreadId '<UUID>'` 可只验证参数，不启动服务。

管理页打开后：

1. 检查 Codex Desktop 已连接，绑定的是你传入的会话。
2. 选择“绑定飞书”，按界面提示扫码完成授权；确认飞书运行状态正常。
3. 在手机私聊机器人发送 `/status`，再到本机管理页确认新发送者身份。
4. 在飞书发送 `/use <同一个本地会话UUID>`，把这个发送者绑定到目标会话。
5. 发一条普通消息，确认它出现在桌面的原会话内，且回复回到飞书。

机器人绑定时生成的 App Secret、本机 API token、身份、消息和日志只保存在本机数据目录。`Open-Settings.ps1` 使用本机 token 打开管理页，请勿复制或分享该授权 URL。

停止后台：

```powershell
.\Stop-Sync.ps1
```

使用自定义数据目录时，对启动、停止、打开管理页传入同一个 `-DataDirectory`。脚本参数可用 `Get-Help .\Start-Sync.ps1 -Full` 查看。这里只提供手动启动脚本，不安装开机任务，也不会启动、关闭或修改你的桌面应用和网络软件。

## 更换会话与故障处理

- 更换会话：等待当前任务、手机队列和审批处理完毕；停止同步服务；在桌面打开新会话；使用新的 `-ThreadId` 启动；在飞书再次执行 `/use <新UUID>`。旧聊天保留。
- 桌面离线或会话快照超时：重新打开已绑定的桌面会话。连接器会尝试恢复连接，不会悄悄改绑另一个会话。
- 协议不匹配：查看本机日志并升级本项目的兼容实现；不要直接安装上游 `comote` 覆盖本定制版。
- 发送状态不确定时不会自动重发，避免重复执行；断连会取消尚未提交的内存队列，重启也不会保留它。请先查看电脑是否已收到，再决定重发。
- 飞书无响应：检查管理页中的渠道状态、身份授权和当前会话选择；不要把完整状态文件或日志直接贴到公开 Issue。

## 数据与发布范围

这是从运行代码提取的全新仓库，没有携带原工作区的历史记录、私人运行状态、真实机器人凭据、个人路径、真实会话 ID、教学材料或其他应用的脚本。

本机状态可能包含聊天记录和授权信息；不是加密保险库。请仅在自己的可信 Windows 账号运行，保持管理服务绑定 `127.0.0.1`。不要把数据目录提交到 Git。

提交前可运行：

```powershell
npm test
npm run check:privacy
```

隐私检查会检查 Git 跟踪文件（首次初始化前检查源码目录），拒绝常见运行数据、个人用户路径、凭据和真实格式的平台标识。它不能代替人工检查，分享日志或新增文件前仍需核对内容。

## 开发与归属

- `src/connectors/codex-desktop/desktop-ipc-*.js`：同会话桌面连接、队列和事件处理。
- `src/server/`、`src/core/`：本机 API、身份授权、会话路由与消息投递。
- `src/channels/feishu/`：飞书收发和格式化；`public/`：本机管理界面。
- `tests/`：合成会话和模拟 IPC/飞书驱动测试，不发送真实消息。
- PowerShell 脚本：独立运行目录、启动停止和本机管理页授权。

本仓库移除了所分发文件中不可用的 Tauri 打包命令及上下文监测集成，关闭上游更新轮询和下载指引；`update` 命令仅说明如何手动更新。直接无配置运行 `node bin/comote.js` 会被拒绝，请使用 `Start-Sync.ps1`；旧版通用 CLI 子命令不在此发布版入口开放，避免误读其他 Comote 配置。

`package.json` 标为 `private`，不向 npm 发布上游同名包；更新本项目请从此仓库获取代码并重新安装锁定依赖。

Comote 原作者 **Gavin Yang**，许可证见 [LICENSE](LICENSE)。二维码组件及其他依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

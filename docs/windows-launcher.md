# Windows 启动与本地配置

在仓库目录安装 Node.js 22+ 依赖后运行：

```powershell
npm ci --ignore-scripts
.\Start-Sync.ps1 -ThreadId '<要绑定的桌面会话 UUID>'
.\Open-Settings.ps1
```

先在 Codex/ChatGPT 桌面打开目标会话，再启动同步服务。脚本默认使用 `%LOCALAPPDATA%\codex-feishuRemote` 保存私有运行数据，监听 `127.0.0.1:16208`。若已有其他服务占用端口，脚本直接拒绝，使用 `-Port 16209` 等空闲端口；不会停止既有服务。自定义 Node.js 路径使用 `-NodePath`。

首次启动会生成本机随机 API 令牌，以及 `local-settings.json`。其中只有会话 ID、端口和 Node.js 路径；此后可以省略 `-ThreadId`。更换会话前先停止当前实例，再显式提供新 ID。配置与状态目录必须位于仓库外，不能使用生产实例的现有数据目录；每个实例应有独立目录和端口。

`Open-Settings.ps1` 会核对本实例的进程、端口与 API，再在默认浏览器打开本地配置页。在页面选择“绑定飞书”，按提示扫码授权，并确认允许访问的用户。脚本不复制任何既有机器人的凭据。令牌通过 URL fragment 传入，页面会立即从地址栏和当前历史条目清除，并保存在该本地地址的浏览器存储中；令牌不进入 HTTP 请求路径或脚本日志。不要分享启动中的完整 URL、浏览器存储或本地数据目录。

```powershell
# 如使用自定义数据目录，三个脚本都传相同目录。
.\Start-Sync.ps1 -ThreadId '<会话 UUID>' -DataDirectory "$env:LOCALAPPDATA\my-sync-instance" -Port 16209
.\Open-Settings.ps1 -DataDirectory "$env:LOCALAPPDATA\my-sync-instance"
.\Stop-Sync.ps1 -DataDirectory "$env:LOCALAPPDATA\my-sync-instance"
```

停止前先等桌面任务和待审批操作完成。停止脚本核验 PID、进程创建时间、Node.js 路径和本仓库入口；任何身份不符都拒绝操作。默认在存在排队或正在提交到桌面的手机消息时拒绝停止；这个自动检查不能识别所有已开始执行的桌面任务或审批。实例异常且无法确认提交状态时，可在检查后主动使用 `-Force`；它只跳过提交状态检查，仍然执行全部进程身份核验。停止后保留本地配置和凭据。

`Start-Sync.ps1` 的 `started` 表示本机服务已通过认证状态检查；桌面连接状态另列为 `DesktopState`，首次未连接时保持目标会话窗口打开后再检查。日志在数据目录的 `server.stdout.log`、`server.stderr.log`，可能包含运行信息，不应提交 Git。

纯参数验证不会启动服务、读凭据、联网或创建运行文件：

```powershell
.\Start-Sync.ps1 -ThreadId '00000000-0000-4000-8000-000000000001' -Port 16209 -ValidateOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsLauncher.ps1
node --test .\tests\local-auth.test.js
```

启动器会移除继承的全部 `COMOTE_*` 设置，然后只注入当前实例所需的明确绑定和私有状态路径；上下文百分比监测和自动交接不会由此启动器启用。

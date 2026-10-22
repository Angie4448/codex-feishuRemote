# macOS：Codex 桌面与手机飞书接着聊

需要 macOS、Node.js 22 或更新版本，以及已登录且运行中的 **Codex 桌面应用**。这是已有桌面会话的实验性同步，依赖桌面的本地 IPC 协议；桌面升级改变协议时可能需要更新项目。手机只需能正常使用飞书；电脑仍需能够访问 Codex 服务和飞书服务。

## 首次启动

在仓库目录执行：

```sh
npm ci --ignore-scripts
bash ./start-macos.sh --thread-id '<目标 Codex 桌面会话 UUID>'
bash ./open-settings-macos.sh
```

先在桌面打开目标会话，再启动同步。首次必须明确提供该会话的本地 `threadId`（UUID），不是 ChatGPT 分享链接；可从 Codex 的本机会话元数据取得。启动器不会猜测、自动新建或切换会话。不要复制其他人的运行目录或令牌。

本机管理页打开后：

1. 检查桌面连接状态为 `connected`。
2. 选择“绑定飞书”，按提示用自己的飞书扫码授权，并确认渠道运行正常。
3. 在手机上私聊机器人发送 `/status`，到本机管理页确认允许访问的发送者身份。
4. 在飞书发送 `/use <启动时的同一个UUID>`。
5. 发送“Mac 同步测试”，确认文字进入桌面原会话，并且回复回到手机。手机可在关闭代理后完成这个验证。

仓库为私有时，需要所有者授予读取权限，或让所有者提供源码 ZIP；无需取得所有者的任何飞书或 Codex 凭据。

默认仅监听 `127.0.0.1:16208`，私有数据放在：

```text
~/Library/Application Support/codex-feishuRemote
```

目录权限为 `0700`，令牌、状态、配置及日志为 `0600`。不需要 `sudo`，也不会安装 `launchd`、开机任务或周期自动化。启动成功后服务在后台运行，关闭启动终端不会退出它。

请保持 Mac 已登录、联网且不处于睡眠状态；合盖或系统休眠可能中断同步。启动器不会启动 Codex 应用本身，开机后需先打开 Codex 和目标会话，再启动同步。

已有服务占用端口时会拒绝启动，不会关闭占用者。使用另一个空闲端口即可：

```sh
bash ./start-macos.sh --thread-id '<会话 UUID>' --port 16209
```

成功启动后，`local-settings.json` 保存会话 ID、端口和 IPC 路径；下次可以只运行 `bash ./start-macos.sh`。更换会话前先停止本实例，再显式提供新 ID。

## 状态与停止

```sh
bash ./status-macos.sh
bash ./doctor-macos.sh
bash ./stop-macos.sh
```

`started` 表示本地服务通过认证状态检查；`desktopState: connected` 才表示已连接桌面目标会话。若仍在重连，保持 Codex 和目标会话打开后再检查。

停止前先等桌面任务和审批完成。自动停止检查能够识别排队及正在提交的手机消息，不能覆盖所有已经开始执行的桌面任务。停止只针对经 UID、启动时间、完整程序命令和随机实例标记核实的进程，绝不只凭 PID 杀进程。异常服务无法返回 API 状态时，可检查后主动使用 `--force`；它仍然核验全部进程身份，也不会强杀其他程序。

停止保留配置及凭据。数据目录存在 `launcher.lock` 时，表示另一条启停命令仍在执行；若上次命令异常退出，应先确认没有启停命令运行，再处理这个锁文件，不要删除其他运行记录来绕过核验。

## IPC 路径与独立实例

已核实的默认 IPC 路径为：

```text
${CODEX_HOME:-$HOME/.codex}/ipc/ipc.sock
```

启动器和连接器会检查该路径确实是当前用户拥有的 Unix socket，及其父目录的权限。不会扫描其他用户的目录，也不会尝试旧版临时目录作为回退。仅在已核实自己的 Codex 使用其他路径时覆盖：

```sh
bash ./start-macos.sh --thread-id '<会话 UUID>' \
  --ipc-socket '/已核实的绝对路径/ipc.sock' \
  --data-dir "$HOME/Library/Application Support/codex-feishuRemote-other" \
  --port 16209
bash ./status-macos.sh --data-dir "$HOME/Library/Application Support/codex-feishuRemote-other"
```

使用自定义数据目录时，打开配置、查看状态和停止都要传同一 `--data-dir`。数据目录必须是仓库外的专用目录，不会接管已有无标记的非空目录。不要在多个实例中使用同一飞书机器人凭据，避免重复处理消息。

本地配置页通过 URL fragment 接收本机令牌，页面立即清除地址栏中的 fragment 后存入该本地地址的浏览器存储；令牌不会进入 HTTP 请求路径或启动器输出。它会短暂经过本机浏览器打开命令，请勿分享完整启动 URL、浏览器存储或运行目录。

## 验证与限制

```sh
bash ./start-macos.sh --thread-id '00000000-0000-4000-8000-000000000001' --validate-only
npm test
```

`--validate-only` 只检查明确参数，不读取已有凭据、不探测 socket、不联网、不创建运行文件。启动器会清除继承的 `COMOTE_*` 设置，只注入该实例明确指定的参数；不会启用上下文监测或自动交接。

自动测试包含一个 POSIX 集成用例：建立短路径、私有权限的假 Unix socket，启动真实服务，以合成会话验证认证、状态、重复启动和停止。它不连接真实 Codex、不配置飞书、不发送消息。该测试在 Windows 上跳过；本次发布尚未在 macOS 执行，朋友可先在 Mac 仓库目录运行 `npm test`，再做实际双向飞书验收。GitHub 工作流模板位于 `docs/ci/macos-check.yml`，因当前授权缺少 `workflow` 权限尚未启用。

日志在数据目录的 `server.stdout.log` 与 `server.stderr.log`。运行信息可能包含消息或用户资料，分享排错信息前应脱敏；不要提交这些文件到 Git。

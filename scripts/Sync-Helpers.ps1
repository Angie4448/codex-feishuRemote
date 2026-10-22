# Windows PowerShell 5.1+. Runtime files stay outside this checkout.
Set-StrictMode -Version 2.0

function Resolve-SyncDataDirectory {
    param([string]$DataDirectory, [string]$RepositoryRoot)
    if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
        $base = [Environment]::GetFolderPath('LocalApplicationData')
        if (-not $base) { throw 'LocalApplicationData is unavailable; supply -DataDirectory.' }
        $DataDirectory = Join-Path $base 'codex-feishuRemote'
    }
    $full = [IO.Path]::GetFullPath($DataDirectory).TrimEnd('\', '/')
    $repo = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\', '/')
    if ($full -ieq $repo -or $full.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'DataDirectory must be outside the repository, to keep credentials out of Git.'
    }
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')) { throw 'Use a dedicated data folder, not a drive root.' }
    return $full
}

function Read-SyncJson {
    param([string]$Path)
    if (-not [IO.File]::Exists($Path)) { return $null }
    try { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'A local runtime JSON file is invalid. Inspect it locally; its contents were not logged.' }
}

function Write-SyncJson {
    param([string]$Path, [object]$Value)
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $Path -Force -ErrorAction Stop
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Get-SyncValue {
    param([object]$Object, [string]$Name, [object]$Default = $null)
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}

function Resolve-SyncPlan {
    param([string]$RepositoryRoot, [string]$DataDirectory, [string]$ThreadId, [int]$Port,
        [string]$NodePath, [bool]$PortWasSpecified, [switch]$ValidateOnly)
    $data = Resolve-SyncDataDirectory -DataDirectory $DataDirectory -RepositoryRoot $RepositoryRoot
    # ValidateOnly deliberately does not read local configuration, credentials,
    # process state or the network. Pass a synthetic explicit ThreadId in tests.
    if (-not $ValidateOnly) {
        $settings = Read-SyncJson -Path (Join-Path $data 'local-settings.json')
        if (-not $ThreadId) { $ThreadId = [string](Get-SyncValue $settings 'threadId') }
        if (-not $PortWasSpecified) { $Port = [int](Get-SyncValue $settings 'port' $Port) }
        if (-not $NodePath) { $NodePath = [string](Get-SyncValue $settings 'nodePath') }
    }
    $parsedThread = [Guid]::Empty
    if (-not [Guid]::TryParse($ThreadId, [ref]$parsedThread) -or $parsedThread -eq [Guid]::Empty) {
        throw 'Supply -ThreadId with the intended desktop conversation UUID, or set threadId in local-settings.json. ValidateOnly requires an explicit ID.'
    }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
    if ($NodePath) { $NodePath = [IO.Path]::GetFullPath($NodePath) }
    if (-not $ValidateOnly) {
        if (-not $NodePath) {
            $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -eq $command) { throw 'Node.js was not found. Install Node.js or supply -NodePath.' }
            $NodePath = $command.Source
        }
        if (-not [IO.File]::Exists($NodePath)) { throw 'The configured Node.js executable does not exist.' }
    }
    return [pscustomobject]@{
        RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
        DataDirectory = $data
        ThreadId = $parsedThread.ToString()
        Port = $Port
        NodePath = $NodePath
        ServerScript = Join-Path $RepositoryRoot 'bin\comote.js'
        StatePath = Join-Path $data 'state.json'
        TokenPath = Join-Path $data 'api-token.txt'
        RecordPath = Join-Path $data 'instance.json'
        SettingsPath = Join-Path $data 'local-settings.json'
    }
}

function Get-SyncToken {
    param([string]$Path, [switch]$Create)
    if (-not [IO.File]::Exists($Path)) {
        if (-not $Create) { throw 'Local API token file is missing. Start this instance first.' }
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $generated = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
        # CreateNew never replaces an existing token in a concurrent launch.
        $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $tokenBytes = [Text.Encoding]::UTF8.GetBytes($generated)
            $stream.Write($tokenBytes, 0, $tokenBytes.Length)
        } finally { $stream.Dispose() }
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
        foreach ($sid in @($userSid, $systemSid)) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    }
    $token = [IO.File]::ReadAllText($Path).Trim()
    if ($token -cnotmatch '^[0-9a-f]{64}$') { throw 'The local API token file has an unexpected format; it was not printed or replaced.' }
    return $token
}

function Get-SyncProcess {
    param([object]$Record, [string]$RepositoryRoot)
    if ($null -eq $Record) { return $null }
    if ((Get-SyncValue $Record 'schemaVersion') -ne 1 -or
        [string](Get-SyncValue $Record 'repositoryRoot') -ine [IO.Path]::GetFullPath($RepositoryRoot)) {
        throw 'The runtime record belongs to another checkout or is invalid; no process was changed.'
    }
    $processId = [int](Get-SyncValue $Record 'processId' 0)
    if ($processId -le 0) { throw 'The runtime PID is invalid.' }
    $live = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $live) { return $null }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $processId) -ErrorAction Stop
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
        throw 'Cannot inspect the recorded process in this user session; refusing to guess its identity.'
    }
    $scriptPath = Join-Path $RepositoryRoot 'bin\comote.js'
    $scriptPattern = '(?:^|\s)"?' + [regex]::Escape($scriptPath) + '"?(?=\s|$)'
    $creationUtc = ([DateTime]$process.CreationDate).ToUniversalTime().ToString('o')
    if ($process.ExecutablePath -ine [string](Get-SyncValue $Record 'nodePath') -or
        $creationUtc -cne [string](Get-SyncValue $Record 'processCreatedAtUtc') -or
        [string]$process.CommandLine -notmatch $scriptPattern -or
        [string](Get-SyncValue $Record 'serverScript') -ine $scriptPath) {
        throw 'Recorded PID does not match this instance (path/start time/command mismatch); no process was changed.'
    }
    return $process
}

function Test-SyncPortOccupied {
    param([int]$Port)
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return @($listeners | Where-Object { $_.Port -eq $Port }).Count -gt 0
}

function Test-SyncListenerOwner {
    param([int]$Port, [int]$ProcessId)
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    return @($listeners | Where-Object { $_.OwningProcess -eq $ProcessId -and $_.LocalAddress -eq '127.0.0.1' }).Count -gt 0
}

function Get-SyncStatus {
    param([object]$Record, [string]$Token)
    $port = [int](Get-SyncValue $Record 'port')
    if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid runtime port.' }
    if (-not (Test-SyncListenerOwner -Port $port -ProcessId ([int]$Record.processId))) { throw 'The local port is not owned by the recorded instance.' }
    # WebRequest with Proxy=null prevents a machine proxy from seeing the token.
    $request = [Net.HttpWebRequest]::Create(('http://127.0.0.1:{0}/api/status' -f $port))
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 3000
    $request.Headers['Authorization'] = 'Bearer ' + $Token
    $response = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $status = $reader.ReadToEnd() | ConvertFrom-Json
    } catch { throw 'The owned local API did not return an authenticated status response.' }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
    if ($status.bridge -ne 'running' -or $status.connectors.desktop.threadId -cne $Record.threadId) {
        throw 'The local API reports a different conversation or unexpected service.'
    }
    return $status
}

function Get-SyncChildEnvironment {
    param([object]$Plan, [string]$Token)
    $result = @{}
    foreach ($key in [Environment]::GetEnvironmentVariables('Process').Keys) {
        if ([string]$key -match '^(?i:COMOTE_)' -or [string]$key -in @('HOST', 'PORT', 'NODE_OPTIONS', 'NODE_PATH')) { continue }
        $result[[string]$key] = [Environment]::GetEnvironmentVariable([string]$key, 'Process')
    }
    $result['HOST'] = '127.0.0.1'
    $result['PORT'] = [string]$Plan.Port
    $result['COMOTE_CODEX_DESKTOP_IPC'] = '1'
    $result['COMOTE_CODEX_DESKTOP_IPC_THREAD_ID'] = $Plan.ThreadId
    $result['COMOTE_STATE_PATH'] = $Plan.StatePath
    $result['COMOTE_LOCAL_API_TOKEN'] = $Token
    return $result
}

function Start-SyncChild {
    param([object]$Plan, [string]$Token)
    # Start-Process redirects to local files without leaving an unread pipe.
    # Environment changes are confined to this script process and restored.
    $desired = Get-SyncChildEnvironment -Plan $Plan -Token $Token
    $before = @{}
    foreach ($key in [Environment]::GetEnvironmentVariables('Process').Keys) {
        $before[[string]$key] = [Environment]::GetEnvironmentVariable([string]$key, 'Process')
    }
    try {
        foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
            if (-not $desired.ContainsKey([string]$key)) { [Environment]::SetEnvironmentVariable([string]$key, $null, 'Process') }
        }
        foreach ($key in $desired.Keys) { [Environment]::SetEnvironmentVariable($key, $desired[$key], 'Process') }
        return Start-Process -FilePath $Plan.NodePath -ArgumentList @(('"{0}"' -f $Plan.ServerScript), 'serve') -WorkingDirectory $Plan.RepositoryRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Plan.DataDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $Plan.DataDirectory 'server.stderr.log') -ErrorAction Stop
    } finally {
        foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
            if (-not $before.ContainsKey([string]$key)) { [Environment]::SetEnvironmentVariable([string]$key, $null, 'Process') }
        }
        foreach ($key in $before.Keys) { [Environment]::SetEnvironmentVariable($key, $before[$key], 'Process') }
    }
}

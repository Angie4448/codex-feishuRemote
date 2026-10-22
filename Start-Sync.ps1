<#
.SYNOPSIS
Starts one isolated, explicitly bound desktop sync instance.
.DESCRIPTION
Uses a private local data directory, rejects occupied ports, and never stops
another program. ValidateOnly checks explicit parameters without side effects.
.EXAMPLE
.\Start-Sync.ps1 -ThreadId '<desktop conversation UUID>' -Port 16209
.EXAMPLE
.\Start-Sync.ps1 -ThreadId '00000000-0000-4000-8000-000000000001' -ValidateOnly
#>
[CmdletBinding()]
param(
    [string]$ThreadId,
    [string]$DataDirectory,
    [ValidateRange(1, 65535)][int]$Port = 16208,
    [string]$NodePath,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Sync-Helpers.ps1')
$plan = Resolve-SyncPlan -RepositoryRoot $PSScriptRoot -DataDirectory $DataDirectory -ThreadId $ThreadId -Port $Port -NodePath $NodePath -PortWasSpecified $PSBoundParameters.ContainsKey('Port') -ValidateOnly:$ValidateOnly
if ($ValidateOnly) {
    [pscustomobject]@{ Valid=$true; Mode='validation-only'; DataDirectory=$plan.DataDirectory; ThreadId=$plan.ThreadId; Port=$plan.Port; Host='127.0.0.1'; ContextMonitoring=$false }
    return
}
if (-not [IO.File]::Exists($plan.ServerScript)) { throw 'The server entrypoint is missing from this checkout.' }
[IO.Directory]::CreateDirectory($plan.DataDirectory) | Out-Null
$lock = $null
try {
    try { $lock = New-Object IO.FileStream((Join-Path $plan.DataDirectory 'launcher.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another launcher is using this data directory. Wait for it to finish.' }
    $oldRecord = Read-SyncJson -Path $plan.RecordPath
    $oldProcess = Get-SyncProcess -Record $oldRecord -RepositoryRoot $PSScriptRoot
    if ($null -ne $oldProcess) {
        if ($oldRecord.threadId -cne $plan.ThreadId -or [int]$oldRecord.port -ne $plan.Port) {
            throw 'This data directory already has a different running binding/port. Stop it explicitly before changing the binding.'
        }
        $token = Get-SyncToken -Path $plan.TokenPath
        $status = Get-SyncStatus -Record $oldRecord -Token $token
        [pscustomobject]@{ Result='already-running'; ProcessId=$oldRecord.processId; Port=$plan.Port; DesktopState=$status.connectors.desktop.state }
        return
    }
    if (Test-SyncPortOccupied -Port $plan.Port) { throw 'The selected port is already occupied. Nothing was stopped; choose a different -Port.' }
    $token = Get-SyncToken -Path $plan.TokenPath -Create
    Write-SyncJson -Path $plan.SettingsPath -Value ([ordered]@{ threadId=$plan.ThreadId; port=$plan.Port; nodePath=$plan.NodePath })
    $child = Start-SyncChild -Plan $plan -Token $token
    $live = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $child.Id) -ErrorAction Stop
    if ($null -eq $live) { throw 'The server exited immediately. Inspect the local server.stderr.log; its contents are not printed automatically.' }
    $record = [pscustomobject]@{
        schemaVersion=1; repositoryRoot=$plan.RepositoryRoot; serverScript=$plan.ServerScript
        nodePath=$plan.NodePath; processId=$child.Id
        processCreatedAtUtc=([DateTime]$live.CreationDate).ToUniversalTime().ToString('o')
        port=$plan.Port; threadId=$plan.ThreadId
    }
    Write-SyncJson -Path $plan.RecordPath -Value $record
    $deadline = (Get-Date).AddSeconds(20)
    do {
        if ($null -eq (Get-SyncProcess -Record $record -RepositoryRoot $PSScriptRoot)) { throw 'The server exited during startup. Inspect the local server.stderr.log.' }
        try { $status = Get-SyncStatus -Record $record -Token $token; break } catch { $status=$null }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if ($null -eq $status) { throw 'The server has not passed its local status check. Its verified PID record is retained; no other process was stopped.' }
    [pscustomobject]@{ Result='started'; ProcessId=$record.processId; Port=$plan.Port; DesktopState=$status.connectors.desktop.state; SettingsCommand='.\Open-Settings.ps1'; DataDirectory=$plan.DataDirectory }
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
    $token = $null
}

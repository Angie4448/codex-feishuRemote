<#
.SYNOPSIS
Stops only the verified instance launched from this checkout.
.DESCRIPTION
First wait for desktop tasks and approvals to finish. The automatic idle check
only detects queued/in-flight phone submissions, not all desktop execution.
Force skips that check but never skips process identity verification.
.EXAMPLE
.\Stop-Sync.ps1
#>
[CmdletBinding()]
param([string]$DataDirectory, [switch]$Force, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Sync-Helpers.ps1')
$data = Resolve-SyncDataDirectory -DataDirectory $DataDirectory -RepositoryRoot $PSScriptRoot
if ($ValidateOnly) { [pscustomobject]@{ Valid=$true; Mode='validation-only'; DataDirectory=$data }; return }
$recordPath = Join-Path $data 'instance.json'
if (-not [IO.Directory]::Exists($data)) { Write-Output 'No local data directory; nothing stopped.'; return }
$lock=$null
try {
try { $lock=New-Object IO.FileStream((Join-Path $data 'launcher.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { throw 'Another launcher is using this data directory. Wait for it to finish.' }
$record = Read-SyncJson -Path $recordPath
if ($null -eq $record) { Write-Output 'No instance record in this data directory; nothing stopped.'; return }
$owned = Get-SyncProcess -Record $record -RepositoryRoot $PSScriptRoot
if ($null -eq $owned) { Write-Output 'Recorded instance is not running; nothing stopped.'; return }
if (-not $Force) {
    $token = Get-SyncToken -Path (Join-Path $data 'api-token.txt')
    try { $status = Get-SyncStatus -Record $record -Token $token }
    catch { throw 'Cannot confirm this instance is idle. Inspect it first; -Force only bypasses the idle check, never process identity checks.' }
    finally { $token=$null }
    $desktop=$status.connectors.desktop
    if ([int](Get-SyncValue $desktop 'queuedMessages' 0) -gt 0 -or
        (Get-SyncValue $desktop 'sending' $false) -or (Get-SyncValue $desktop 'awaitingTurnId')) {
        throw 'This instance has queued or in-flight phone submissions. Wait for submission to finish; also finish desktop tasks and approvals before stopping.'
    }
}
# Re-check PID creation time, executable and entrypoint immediately before stop.
$owned = Get-SyncProcess -Record $record -RepositoryRoot $PSScriptRoot
if ($null -eq $owned) { Write-Output 'Instance already exited; nothing stopped.'; return }
Stop-Process -Id $owned.ProcessId -ErrorAction Stop
Wait-Process -Id $owned.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
if ($null -ne (Get-SyncProcess -Record $record -RepositoryRoot $PSScriptRoot)) { throw 'The verified instance did not exit; its record was retained.' }
[IO.File]::Delete($recordPath)
Write-Output 'Stopped only the verified instance. Local configuration and credentials were retained.'

} finally { if ($null -ne $lock) { $lock.Dispose() } }

[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'scripts\Sync-Helpers.ps1')
$count=0
function Check([string]$Name, [bool]$Condition) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $script:count++
}
function Reject([string]$Name, [scriptblock]$Action) {
    $rejected=$false
    try { & $Action | Out-Null } catch { $rejected=$true }
    Check $Name $rejected
}
$fixtureId='00000000-0000-4000-8000-000000000001'
$unusedData=Join-Path ([IO.Path]::GetTempPath()) ('sync-validate-' + [Guid]::NewGuid().ToString('N'))
$plan=Resolve-SyncPlan -RepositoryRoot $repo -DataDirectory $unusedData -ThreadId $fixtureId -Port 16209 -PortWasSpecified $true -ValidateOnly
Check 'explicit local binding' ($plan.ThreadId -eq $fixtureId)
Check 'port preserved' ($plan.Port -eq 16209)
Check 'plan did not create data directory' (-not [IO.Directory]::Exists($unusedData))
Reject 'missing ID is rejected without reading local settings' { Resolve-SyncPlan -RepositoryRoot $repo -DataDirectory $unusedData -Port 16209 -PortWasSpecified $true -ValidateOnly }
Reject 'null UUID is rejected' { Resolve-SyncPlan -RepositoryRoot $repo -DataDirectory $unusedData -ThreadId ([Guid]::Empty.ToString()) -Port 16209 -PortWasSpecified $true -ValidateOnly }
Reject 'repository data directory is rejected' { Resolve-SyncDataDirectory -DataDirectory (Join-Path $repo 'runtime') -RepositoryRoot $repo }
Reject 'drive root data directory is rejected' { Resolve-SyncDataDirectory -DataDirectory ([IO.Path]::GetPathRoot($repo)) -RepositoryRoot $repo }
$startResult=& (Join-Path $repo 'Start-Sync.ps1') -ThreadId $fixtureId -DataDirectory $unusedData -Port 16209 -ValidateOnly
Check 'Start ValidateOnly returns safe plan' ($startResult.Valid -and -not $startResult.ContextMonitoring)
Check 'Stop ValidateOnly is side-effect free' ((& (Join-Path $repo 'Stop-Sync.ps1') -DataDirectory $unusedData -ValidateOnly).Valid)
Check 'Open ValidateOnly is side-effect free' ((& (Join-Path $repo 'Open-Settings.ps1') -DataDirectory $unusedData -ValidateOnly).Valid)
Check 'all ValidateOnly modes leave no directory' (-not [IO.Directory]::Exists($unusedData))
$saved=@{}
foreach($key in @('COMOTE_CONTEXT_MANAGEMENT_DIR','COMOTE_FEISHU_APP_SECRET','COMOTE_UNRECOGNIZED','HOST','PORT','NODE_OPTIONS')) { $saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process') }
try {
    foreach($key in $saved.Keys){[Environment]::SetEnvironmentVariable($key,'synthetic-inherited-value','Process')}
    $childEnvironment=Get-SyncChildEnvironment -Plan $plan -Token ('a' * 64)
    Check 'unknown COMOTE settings removed' (-not $childEnvironment.ContainsKey('COMOTE_UNRECOGNIZED'))
    Check 'inherited channel secret removed' (-not $childEnvironment.ContainsKey('COMOTE_FEISHU_APP_SECRET'))
    Check 'context monitoring not inherited' (-not $childEnvironment.ContainsKey('COMOTE_CONTEXT_MANAGEMENT_DIR'))
    Check 'NODE_OPTIONS not inherited' (-not $childEnvironment.ContainsKey('NODE_OPTIONS'))
    Check 'loopback enforced' ($childEnvironment.HOST -eq '127.0.0.1')
    Check 'per-instance state path enforced' ($childEnvironment.COMOTE_STATE_PATH -eq $plan.StatePath)
    Check 'explicit thread enforced' ($childEnvironment.COMOTE_CODEX_DESKTOP_IPC_THREAD_ID -eq $fixtureId)
} finally { foreach($key in $saved.Keys){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')} }

# Mock both process readers. No real process inspection or termination occurs.
$fakeCreated=[DateTime]::Parse('2020-01-02T03:04:05Z').ToUniversalTime()
$fakeNode=Join-Path ([IO.Path]::GetPathRoot($repo)) 'synthetic-node\node.exe'
$fakeProcess=[pscustomobject]@{ProcessId=4242;ExecutablePath=$fakeNode;CreationDate=$fakeCreated;CommandLine=('"{0}" "{1}" serve' -f $fakeNode,$plan.ServerScript)}
function Get-Process { param($Id,$ErrorAction) [pscustomobject]@{Id=$Id} }
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) $script:fakeProcess }
$record=[pscustomobject]@{schemaVersion=1;repositoryRoot=$plan.RepositoryRoot;serverScript=$plan.ServerScript;nodePath=$fakeNode;processId=4242;processCreatedAtUtc=$fakeCreated.ToString('o');port=16209;threadId=$fixtureId}
Check 'matching PID path command and start time accepted' ($null -ne (Get-SyncProcess -Record $record -RepositoryRoot $repo))
$record.processCreatedAtUtc=$fakeCreated.AddSeconds(-1).ToString('o')
Reject 'reused PID creation time rejected' { Get-SyncProcess -Record $record -RepositoryRoot $repo }
$record.processCreatedAtUtc=$fakeCreated.ToString('o')
$fakeProcess.CommandLine='node.exe another-service.js serve'
Reject 'different program at recorded PID rejected' { Get-SyncProcess -Record $record -RepositoryRoot $repo }
$fakeProcess.CommandLine=('"{0}" "{1}" serve' -f $fakeNode,$plan.ServerScript)
$record.repositoryRoot=Join-Path $repo 'another-checkout'
Reject 'another checkout record rejected' { Get-SyncProcess -Record $record -RepositoryRoot $repo }
Write-Output ("PASS: {0} isolated launcher assertions; no instance started/stopped, no network calls or runtime files created." -f $count)

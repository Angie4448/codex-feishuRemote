<#
.SYNOPSIS
Opens the verified local settings page with local browser authentication.
.DESCRIPTION
Checks this checkout's process identity and authenticated API. The token is
passed in a URL fragment that the page immediately removes, never printed.
.EXAMPLE
.\Open-Settings.ps1
#>
[CmdletBinding()]
param([string]$DataDirectory, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Sync-Helpers.ps1')
$data = Resolve-SyncDataDirectory -DataDirectory $DataDirectory -RepositoryRoot $PSScriptRoot
if ($ValidateOnly) { [pscustomobject]@{ Valid=$true; Mode='validation-only'; DataDirectory=$data }; return }
$record = Read-SyncJson -Path (Join-Path $data 'instance.json')
if ($null -eq $record -or $null -eq (Get-SyncProcess -Record $record -RepositoryRoot $PSScriptRoot)) { throw 'This instance is not running. Start it first.' }
$token = Get-SyncToken -Path (Join-Path $data 'api-token.txt')
try {
    $null = Get-SyncStatus -Record $record -Token $token
    # Fragment is not sent in HTTP requests. local-auth.js immediately removes it
    # from the address bar/history before storing the token for this local origin.
    $url = 'http://127.0.0.1:{0}/#token={1}' -f $record.port, $token
    try { Start-Process -FilePath $url -ErrorAction Stop | Out-Null }
    catch { throw 'Could not open the default browser. No token or launch URL was printed.' }
    Write-Output 'Opened the verified local settings page in your default browser. The API token was not printed.'
} finally { $token=$null; $url=$null }

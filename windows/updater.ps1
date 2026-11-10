param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'

function Write-UpdateLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Get-InstallerSha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Show-UpdateError([string]$Message) {
  Write-UpdateLog "ERROR $Message"
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Automatic update failed: $Message`n`nThe installer was kept for a manual retry.",
    "codex phone assistant",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

try {
  $Installer = [System.IO.Path]::GetFullPath($Installer)
  $AppPath = [System.IO.Path]::GetFullPath($AppPath)
  $LogPath = [System.IO.Path]::GetFullPath($LogPath)
  $ExpectedSha256 = $ExpectedSha256.Trim().ToLowerInvariant()
  if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Invalid installer digest' }
  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'Installer not found' }
  if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) { throw 'Application path not found' }

  Write-UpdateLog "Waiting for process $ParentPid"
  $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if ($parent -and -not $parent.WaitForExit(60000)) { throw 'The assistant did not exit in time' }
  Start-Sleep -Milliseconds 800

  $actual = Get-InstallerSha256 $Installer
  if ($actual -ne $ExpectedSha256) { throw 'Installer SHA-256 verification failed' }
  Write-UpdateLog "Starting silent installer"
  $setup = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "Installer returned exit code $($setup.ExitCode)" }
  if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) { throw 'Application was not found after installation' }
  Write-UpdateLog "Update installed; restarting application"
  Start-Process -FilePath $AppPath -WorkingDirectory (Split-Path -Parent $AppPath)
} catch {
  Show-UpdateError $_.Exception.Message
  exit 1
}

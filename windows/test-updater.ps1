param(
  [string]$BuildRoot = (Join-Path $PSScriptRoot '..\build\windows')
)

$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([System.IO.Path]::GetFullPath($BuildRoot)) ('updater-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $testRoot | Out-Null
try {
  $fixture = Join-Path $testRoot 'fixture.exe'
  $source = @'
using System;
using System.Linq;
using System.Threading;
public static class Fixture {
    public static int Main(string[] args) {
        if (args.Contains("--sleep")) Thread.Sleep(1500);
        return 0;
    }
}
'@
  Add-Type -TypeDefinition $source -OutputAssembly $fixture -OutputType ConsoleApplication
  $stream = [System.IO.File]::OpenRead($fixture)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
  $log = Join-Path $testRoot 'update.log'
  $parent = Start-Process -FilePath $fixture -ArgumentList '--sleep' -WindowStyle Hidden -PassThru
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'updater.ps1') `
    -ParentPid $parent.Id `
    -Installer $fixture `
    -ExpectedSha256 $hash `
    -AppPath $fixture `
    -LogPath $log
  if ($LASTEXITCODE -ne 0) { throw "Updater helper failed with exit code $LASTEXITCODE" }
  $entries = Get-Content -LiteralPath $log -Raw
  foreach ($expected in @('Waiting for process', 'Starting silent installer', 'Update installed; restarting application')) {
    if ($entries -notmatch [regex]::Escape($expected)) { throw "Updater log is missing: $expected" }
  }
  Write-Output 'Windows updater helper self-test passed: wait, hash, silent install and restart.'
} finally {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction Stop
      break
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
}

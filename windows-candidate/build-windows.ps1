param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\build\windows\dist'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $projectRoot 'build\windows'
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$buildPrefix = [System.IO.Path]::GetFullPath($buildRoot) + [System.IO.Path]::DirectorySeparatorChar
if (-not $OutputDirectory.StartsWith($buildPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDirectory must be inside $buildRoot"
}
if (Test-Path -LiteralPath $OutputDirectory) {
  if (-not $Force) { throw "Output already exists: $OutputDirectory" }
  Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
}

$dotnet = Join-Path $projectRoot '.tools\dotnet\dotnet.exe'
if (-not (Test-Path -LiteralPath $dotnet)) {
  $command = Get-Command dotnet -ErrorAction Stop
  $dotnet = $command.Source
}

$nodeVersion = '22.17.1'
$nodeArchive = "node-v$nodeVersion-win-x64.zip"
$nodeUrl = if ($env:NODE_ARCHIVE_URL) { $env:NODE_ARCHIVE_URL } else { "https://nodejs.org/dist/v$nodeVersion/$nodeArchive" }
$cache = Join-Path $projectRoot '.tools\cache'
$nodeZip = Join-Path $cache $nodeArchive
New-Item -ItemType Directory -Force $cache | Out-Null
if (-not (Test-Path -LiteralPath $nodeZip)) {
  Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
}
$checksums = Join-Path $cache "SHASUMS256-v$nodeVersion.txt"
if (-not (Test-Path -LiteralPath $checksums)) {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile $checksums
}
$line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "\s$([regex]::Escape($nodeArchive))$" } | Select-Object -First 1
if (-not $line) { throw "Node checksum is unavailable for $nodeArchive" }
$expected = ($line -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Node checksum mismatch' }

$extract = Join-Path $cache "node-v$nodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $extract 'node.exe'))) {
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $cache -Force
}

New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
& $dotnet publish (Join-Path $PSScriptRoot 'Shell\CodexPhone.csproj') -c Release -r win-x64 --self-contained true -o $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

Copy-Item -LiteralPath (Join-Path $extract 'node.exe') -Destination (Join-Path $OutputDirectory 'node.exe')
$runtime = Join-Path $OutputDirectory 'runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
Get-ChildItem -LiteralPath $projectRoot -File -Filter '*.mjs' |
  Where-Object { $_.Name -notlike '*.test.mjs' } |
  Copy-Item -Destination $runtime
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $runtime
Copy-Item -LiteralPath (Join-Path $projectRoot 'public') -Destination $runtime -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules') -Destination $runtime -Recurse
Set-Content -LiteralPath (Join-Path $OutputDirectory 'runtime-entry.txt') -Value 'windows-app-runtime.mjs' -Encoding utf8NoBOM

node (Join-Path $PSScriptRoot 'png-to-ico.mjs') (Join-Path $projectRoot 'public\app-icon.png') (Join-Path $OutputDirectory 'app.ico')
if ($LASTEXITCODE -ne 0) { throw "Icon conversion failed with exit code $LASTEXITCODE" }

$archive = Join-Path $buildRoot 'codex-phone-assistant-windows-x64.zip'
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $OutputDirectory | Select-Object -ExpandProperty FullName) -DestinationPath $archive -CompressionLevel Optimal

$makensis = Join-Path $projectRoot '.tools\nsis\nsis-3.11\makensis.exe'
if (Test-Path -LiteralPath $makensis) {
  $installer = Join-Path $buildRoot 'installer.nsi'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'installer.nsi') -Destination $installer -Force
  Push-Location $buildRoot
  try {
    & $makensis /V2 /INPUTCHARSET UTF8 $installer
    if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  Write-Output "Installer: $(Join-Path $buildRoot 'codex-phone-assistant-windows-x64-setup.exe')"
} else {
  Write-Warning "NSIS was not found at $makensis; portable app and ZIP were built."
}
Write-Output "Portable app: $OutputDirectory"
Write-Output "Archive: $archive"

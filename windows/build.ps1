param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\build\windows\dist'),
  [string]$Version,
  [int]$BuildNumber = 0,
  [string]$UpdateFeedUrl,
  [string]$InstallerUrl,
  [string]$UpdatePrivateKeyPath = $env:CODEX_PHONE_WINDOWS_UPDATE_PRIVATE_KEY,
  [switch]$SkipUpdateSigning,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
  }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $projectRoot 'build\windows'
$releaseConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'version.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$releaseConfig.version }
if ($BuildNumber -le 0) { $BuildNumber = [int]$releaseConfig.build }
if (-not $UpdateFeedUrl) { $UpdateFeedUrl = [string]$releaseConfig.updateFeedUrl }
if (-not $InstallerUrl) { $InstallerUrl = [string]$releaseConfig.installerUrl }
$releaseNotesUrl = [string]$releaseConfig.releaseNotesUrl
$updatePublicKey = [string]$releaseConfig.updatePublicKey
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must contain three numeric components: $Version" }
if ($BuildNumber -le 0) { throw "BuildNumber must be a positive integer" }
if (-not [Uri]::IsWellFormedUriString($UpdateFeedUrl, [UriKind]::Absolute) -or ([Uri]$UpdateFeedUrl).Scheme -ne 'https') { throw "UpdateFeedUrl must be an HTTPS URL" }
if (-not [Uri]::IsWellFormedUriString($InstallerUrl, [UriKind]::Absolute) -or ([Uri]$InstallerUrl).Scheme -ne 'https') { throw "InstallerUrl must be an HTTPS URL" }
if (-not $updatePublicKey) { throw "version.json must contain updatePublicKey" }
$fileVersion = "$Version.0"
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
$actual = Get-Sha256 $nodeZip
if ($actual -ne $expected) { throw 'Node checksum mismatch' }

$extract = Join-Path $cache "node-v$nodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $extract 'node.exe'))) {
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $cache -Force
}

New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$iconPath = Join-Path $buildRoot 'app.ico'
node (Join-Path $PSScriptRoot 'png-to-ico.mjs') (Join-Path $projectRoot 'public\app-icon.png') $iconPath
if ($LASTEXITCODE -ne 0) { throw "Icon conversion failed with exit code $LASTEXITCODE" }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
& $dotnet publish (Join-Path $PSScriptRoot 'Shell\CodexPhone.csproj') -c Release -r win-x64 --self-contained true -o $OutputDirectory `
  "--property:Version=$Version" `
  "--property:AssemblyVersion=$fileVersion" `
  "--property:FileVersion=$fileVersion" `
  "--property:UpdateBuildNumber=$BuildNumber" `
  "--property:UpdateFeedUrl=$UpdateFeedUrl" `
  "--property:UpdatePublicKey=$updatePublicKey" `
  "--property:UpdateReleaseNotesUrl=$releaseNotesUrl" `
  "--property:ApplicationIcon=$iconPath"
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

Copy-Item -LiteralPath (Join-Path $extract 'node.exe') -Destination (Join-Path $OutputDirectory 'node.exe')
$runtime = Join-Path $OutputDirectory 'runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'src') -Destination $runtime -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $runtime
Copy-Item -LiteralPath (Join-Path $projectRoot 'public') -Destination $runtime -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules') -Destination $runtime -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'updater.ps1') -Destination $OutputDirectory
Copy-Item -LiteralPath $iconPath -Destination (Join-Path $OutputDirectory 'app.ico')
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'runtime-entry.txt'), 'src/runtime.mjs', $utf8NoBom)

$archive = Join-Path $buildRoot 'codex-phone-assistant-windows-x64.zip'
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $OutputDirectory | Select-Object -ExpandProperty FullName) -DestinationPath $archive -CompressionLevel Optimal

$makensis = Join-Path $projectRoot '.tools\nsis\nsis-3.11\makensis.exe'
if (Test-Path -LiteralPath $makensis) {
  $installer = Join-Path $buildRoot 'installer.nsi'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'installer.nsi') -Destination $installer -Force
  Push-Location $buildRoot
  try {
    & $makensis /V2 /INPUTCHARSET UTF8 "/DVERSION=$Version" "/DFILEVERSION=$fileVersion" "/DAPP_ICON=$iconPath" $installer
    if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  Write-Output "Installer: $(Join-Path $buildRoot 'codex-phone-assistant-windows-x64-setup.exe')"
} else {
  Write-Warning "NSIS was not found at $makensis; portable app and ZIP were built."
}

$toolsOutput = Join-Path $buildRoot 'update-tools'
New-Item -ItemType Directory -Force $toolsOutput | Out-Null
& $dotnet publish (Join-Path $PSScriptRoot 'UpdateTools\UpdateTools.csproj') -c Release -o $toolsOutput
if ($LASTEXITCODE -ne 0) { throw "Update tool build failed with exit code $LASTEXITCODE" }
$updateTools = Join-Path $toolsOutput 'UpdateTools.dll'
& $dotnet $updateTools self-test
if ($LASTEXITCODE -ne 0) { throw "Windows update self-test failed with exit code $LASTEXITCODE" }
& powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'test-updater.ps1') -BuildRoot $buildRoot
if ($LASTEXITCODE -ne 0) { throw "Windows updater helper self-test failed with exit code $LASTEXITCODE" }

$installerPath = Join-Path $buildRoot 'codex-phone-assistant-windows-x64-setup.exe'
if (Test-Path -LiteralPath $installerPath) {
  $installerHash = Get-Sha256 $installerPath
  $manifest = [ordered]@{
    schemaVersion = 1
    channel = 'stable'
    version = $Version
    build = $BuildNumber
    publishedAt = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    installer = [ordered]@{
      url = $InstallerUrl
      size = (Get-Item -LiteralPath $installerPath).Length
      sha256 = $installerHash
      signerThumbprint = $null
    }
    releaseNotesUrl = $releaseNotesUrl
  }
  $manifestPath = Join-Path $buildRoot 'latest.json'
  $signaturePath = Join-Path $buildRoot 'latest.json.sig'
  [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), $utf8NoBom)
  if (-not $UpdatePrivateKeyPath) {
    $candidate = Join-Path $env:USERPROFILE '.codex\secrets\codex-phone-windows-update-ecdsa.pk8'
    if (Test-Path -LiteralPath $candidate) { $UpdatePrivateKeyPath = $candidate }
  }
  if ($SkipUpdateSigning) {
    Remove-Item -LiteralPath $signaturePath -Force -ErrorAction SilentlyContinue
    Write-Warning "Update manifest was not signed. Do not publish it as a stable update feed."
  } elseif (-not $UpdatePrivateKeyPath -or -not (Test-Path -LiteralPath $UpdatePrivateKeyPath)) {
    throw "Windows update signing key is unavailable. Set CODEX_PHONE_WINDOWS_UPDATE_PRIVATE_KEY or pass -UpdatePrivateKeyPath."
  } else {
    & $dotnet $updateTools sign --private-key $UpdatePrivateKeyPath --manifest $manifestPath --signature $signaturePath
    if ($LASTEXITCODE -ne 0) { throw "Update manifest signing failed with exit code $LASTEXITCODE" }
    & $dotnet $updateTools verify --manifest $manifestPath --signature $signaturePath --public-key $updatePublicKey
    if ($LASTEXITCODE -ne 0) { throw "Update manifest verification failed with exit code $LASTEXITCODE" }
  }
  $zipPath = Join-Path $buildRoot 'codex-phone-assistant-windows-x64.zip'
  $checksums = @(
    "$(Get-Sha256 $installerPath)  codex-phone-assistant-windows-x64-setup.exe",
    "$(Get-Sha256 $zipPath)  codex-phone-assistant-windows-x64.zip"
  )
  [System.IO.File]::WriteAllText((Join-Path $buildRoot 'SHA256SUMS.txt'), ($checksums -join "`n") + "`n", $utf8NoBom)
  Write-Output "Update manifest: $manifestPath"
  if (Test-Path -LiteralPath $signaturePath) { Write-Output "Update signature: $signaturePath" }
}
Write-Output "Portable app: $OutputDirectory"
Write-Output "Archive: $archive"

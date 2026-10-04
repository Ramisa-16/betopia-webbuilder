$ErrorActionPreference = 'Stop'

$Repo = 'betopia-ai/betopia-webbuilder-releases'
$LatestJsonUrl = "https://github.com/$Repo/releases/latest/download/latest.json"

function Get-PlatformKey {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

  if ($IsWindows) { return 'windows-x86_64' }
  if ($IsMacOS) {
    if ($arch -eq [System.Runtime.InteropServices.Architecture]::Arm64) { return 'darwin-aarch64' }
    return 'darwin-x86_64'
  }
  return 'linux-x86_64'
}

$release = Invoke-RestMethod $LatestJsonUrl
$platformKey = Get-PlatformKey

if (-not $release.platforms.$platformKey) {
  throw "No release asset published for platform '$platformKey'."
}

$asset = $release.platforms.$platformKey
if (-not $asset.url) {
  throw "Release manifest does not include a download URL for '$platformKey'."
}

$fileName = Split-Path $asset.url -Leaf
$downloadPath = Join-Path $env:TEMP $fileName

Write-Host "Downloading $fileName..."
Invoke-WebRequest $asset.url -OutFile $downloadPath

if ($IsWindows) {
  Write-Host "Download completed: $downloadPath"
  Write-Host "Run the installer from File Explorer or from this path."
  exit 0
}

Write-Host "Download completed: $downloadPath"

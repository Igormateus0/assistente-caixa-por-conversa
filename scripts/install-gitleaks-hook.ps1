$ErrorActionPreference = 'Stop'

$version = '8.30.1'
$expectedSha256 = 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolsDirectory = Join-Path $repoRoot '.tools'
$downloadDirectory = Join-Path $env:TEMP "gitleaks-$version"
$archiveName = "gitleaks_${version}_windows_x64.zip"
$archivePath = Join-Path $downloadDirectory $archiveName
$extractPath = Join-Path $downloadDirectory 'extracted'
$scannerPath = Join-Path $toolsDirectory 'gitleaks.exe'
$hooksPath = Join-Path $repoRoot '.githooks'

New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/gitleaks/gitleaks/releases/download/v$version/$archiveName" -OutFile $archivePath

$actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw 'O checksum do Gitleaks não corresponde ao esperado; o binário não foi instalado.'
}

Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
$downloadedScanner = Join-Path $extractPath 'gitleaks.exe'
if (-not (Test-Path -LiteralPath $downloadedScanner)) {
  throw 'O arquivo gitleaks.exe não foi encontrado no pacote oficial.'
}
Copy-Item -LiteralPath $downloadedScanner -Destination $scannerPath -Force

git -C $repoRoot config --local core.hooksPath $hooksPath
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível configurar o caminho do hook Git.' }

& $scannerPath version
Write-Output 'Hook Gitleaks instalado e ligado ao repositório local.'

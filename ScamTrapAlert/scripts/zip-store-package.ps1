# Zip the store build for Chrome Web Store upload
# Run after: npm run pack:store  (with SCAMTRAP_API_URL set)

$src = Join-Path $PSScriptRoot "..\release\scamtrapalert-extension"
$zip = Join-Path $PSScriptRoot "..\release\scamtrapalert-extension.zip"

if (-not (Test-Path $src)) {
  Write-Error "Missing $src — run pack:store first with SCAMTRAP_API_URL set."
  exit 1
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $src "*") -DestinationPath $zip -Force
Write-Host "Created: $zip"

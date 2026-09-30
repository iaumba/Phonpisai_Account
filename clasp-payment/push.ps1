# Deploy payment script (PhonPhisai payment) to Apps Script.
# Called by push.cmd (bypasses ExecutionPolicy). Run:  clasp-payment\push.cmd
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

$claspJson = Join-Path $PSScriptRoot ".clasp.json"
if ((Get-Content -Raw -LiteralPath $claspJson -ErrorAction Stop) -match "REPLACE_WITH_") {
  throw "Script ID not set in clasp-payment\.clasp.json (Project Settings -> Script ID)"
}

$src = Get-ChildItem -LiteralPath $root -Filter "*.gs" | Where-Object { $_.Name -notin @("Cash_Phonpisai.gs", "บันทึกน้ำมัน.gs") }
if (@($src).Count -ne 1) {
  throw "expected exactly 1 payment .gs in $root, found $(@($src).Count)"
}
$src = $src | Select-Object -First 1

Copy-Item -LiteralPath $src.FullName -Destination (Join-Path $PSScriptRoot "Code.gs") -Force
Write-Host "copied $($src.Name) -> clasp-payment\Code.gs" -ForegroundColor Cyan

$clasp = (Get-Command clasp.cmd -ErrorAction SilentlyContinue).Source
if (-not $clasp) { $clasp = "C:\tools\node-v20.11.1-win-x64\clasp.cmd" }

Push-Location $PSScriptRoot
try {
  & $clasp push --force
  if ($LASTEXITCODE -ne 0) { throw "clasp push failed (exit $LASTEXITCODE)" }
  Write-Host "OK: payment script uploaded to Apps Script" -ForegroundColor Green
} finally {
  Pop-Location
}
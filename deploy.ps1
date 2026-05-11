#!/usr/bin/env pwsh
# Full deploy: build backend + Flutter web, copy to public/, firebase deploy

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host "`n==> Building backend TypeScript..." -ForegroundColor Cyan
Push-Location "$root\backend"
npm run build
Pop-Location

Write-Host "`n==> Building Flutter web..." -ForegroundColor Cyan
Push-Location "$root\flutter"
flutter build web --release
Pop-Location

Write-Host "`n==> Copying Flutter build to public/..." -ForegroundColor Cyan
Copy-Item -Path "$root\flutter\build\web\*" -Destination "$root\public" -Recurse -Force
Write-Host "    Copied. main.dart.js: $((Get-Item "$root\public\main.dart.js").LastWriteTime)"

Write-Host "`n==> Deploying to Firebase..." -ForegroundColor Cyan
Push-Location $root
npx firebase deploy --only functions,hosting
Pop-Location

Write-Host "`nDeploy complete!" -ForegroundColor Green

<#
Deploy the frontend to Vercel.

  powershell -ExecutionPolicy Bypass -File .\deploy-vercel.ps1 -ApiUrl https://studymate-api-production.up.railway.app

-ApiUrl is the public Railway address of the backend (Railway > backend > Settings > Networking).
The script writes that host into vercel.json (so /api/auth/* is forwarded to it and the sign-in
cookie belongs to the Vercel domain) and passes it to the build as REACT_APP_API_URL.
The first run asks you to log in to Vercel and to name the project.
#>
param([Parameter(Mandatory = $true)][string]$ApiUrl)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$ApiUrl = $ApiUrl.TrimEnd('/')
if ($ApiUrl -notmatch '^https://') { throw 'ApiUrl must start with https://' }
$apiHost = ([Uri]$ApiUrl).Host

$cfg = Get-Content vercel.json -Raw
$cfg = $cfg -replace 'https://[^/"]+/api/auth/', "https://$apiHost/api/auth/"
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'vercel.json'), $cfg)
Write-Host "vercel.json now forwards /api/auth/* to $apiHost"

npx vercel@latest deploy --prod --yes --build-env "REACT_APP_API_URL=$ApiUrl" --build-env "REACT_APP_AUTH_URL="
Write-Host ''
Write-Host 'Done. Now put the Vercel address printed above into the backend variables on Railway:' -ForegroundColor Green
Write-Host '  ALLOWED_ORIGINS=https://<your-app>.vercel.app   and   APP_URL=https://<your-app>.vercel.app'

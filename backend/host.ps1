# Share StudyMate from this laptop through a free Cloudflare quick tunnel.
# Before running: Cassandra, the retrieval sidecar and the backend (npm start) must already be up.
#   .\host.ps1            build the frontend, then open the tunnel
#   .\host.ps1 -NoBuild   open the tunnel without rebuilding
param([switch]$NoBuild, [int]$Port = 4000)
$ErrorActionPreference = 'Stop'

# find cloudflared even in a window opened before it was installed
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  $cf = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe",
          "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $cf) {
  Write-Host 'cloudflared is not installed. Install it once with:' -ForegroundColor Yellow
  Write-Host '  winget install --id Cloudflare.cloudflared'
  Write-Host 'then run this script again.'
  exit 1
}

if (-not $NoBuild) {
  Push-Location (Join-Path $PSScriptRoot '..\studymate-frontend')
  try { npm run build; if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' } } finally { Pop-Location }
  Write-Host 'Frontend built. Restart the backend once if it was started before the first build.' -ForegroundColor Yellow
}

try {
  $h = Invoke-RestMethod "http://localhost:$Port/api/health" -TimeoutSec 5
  Write-Host "Backend is up (LLM: $($h.aiProvider))."
} catch {
  Write-Host "The backend is not answering on port $Port. Start it (npm start) and run this again." -ForegroundColor Red
  exit 1
}

Write-Host 'Opening the tunnel. The public link is the https://....trycloudflare.com line below.' -ForegroundColor Green
Write-Host 'It works while this window stays open and the laptop is awake. Ctrl+C closes it.'
& $cf tunnel --url "http://localhost:$Port"

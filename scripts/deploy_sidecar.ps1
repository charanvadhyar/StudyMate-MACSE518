<#
Deploy the retrieval sidecar to the Railway service "retrieval".

  powershell -ExecutionPolicy Bypass -File scripts\deploy_sidecar.ps1

Copies only what the image needs into build\sidecar (code, the Rust kernel source, and the
newest trained quantizer) and uploads that folder. Nothing else in this repository is sent:
in particular books\, data\ (apart from the one quantizer), results\ and .venv\ stay local.
Needs the Railway CLI, logged in and linked to the StudyMate project (see DEPLOY.md).
#>
param([string]$Quantizer = "", [string]$Service = "retrieval")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $Quantizer) {
    $found = Get-ChildItem data -Filter "quantizer_book_*answerai_colbert_small_v1_*.npz" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $found) { throw "No trained quantizer in data\. Pass -Quantizer <file.npz>." }
    $Quantizer = $found.FullName
}

$out = "build\sidecar"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force "$out\deploy\sidecar", "$out\kernel" | Out-Null
Copy-Item pyproject.toml $out
Copy-Item smdb "$out\smdb" -Recurse -Exclude "__pycache__"
Get-ChildItem "$out\smdb" -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Copy-Item kernel\Cargo.toml, kernel\Cargo.lock, kernel\pyproject.toml "$out\kernel"
Copy-Item kernel\src "$out\kernel\src" -Recurse
if (Test-Path kernel\.cargo) { Copy-Item kernel\.cargo "$out\kernel\.cargo" -Recurse }
Copy-Item deploy\sidecar\Dockerfile, deploy\sidecar\start.sh "$out\deploy\sidecar"
Copy-Item deploy\sidecar\Dockerfile "$out\Dockerfile"
Copy-Item $Quantizer "$out\quantizer.npz"
# Windows line endings would break the shell script inside the Linux image
$sh = "$out\deploy\sidecar\start.sh"
[IO.File]::WriteAllText((Resolve-Path $sh), ([IO.File]::ReadAllText((Resolve-Path $sh)) -replace "`r`n", "`n"))

Write-Host "Uploading $out to Railway service '$Service' (quantizer: $(Split-Path $Quantizer -Leaf))"
railway up $out --path-as-root --no-gitignore --service $Service --detach

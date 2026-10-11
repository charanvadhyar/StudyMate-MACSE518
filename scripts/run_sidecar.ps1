<#
Start the retrieval sidecar for StudyMate.

  powershell -ExecutionPolicy Bypass -File scripts\run_sidecar.ps1
  powershell -ExecutionPolicy Bypass -File scripts\run_sidecar.ps1 -Quantizer data\my_quantizer.npz -CassandraPort 9042

What it does
  1. stores a trained quantizer in Cassandra (keyspace smdb) if none is there yet
  2. starts the HTTP service on http://127.0.0.1:8100 with the answerai-colbert-small-v1 model

The sidecar uses the same Cassandra as the StudyMate backend (default 127.0.0.1:9042) and
keeps its tables in its own keyspace, so nothing in the studymate keyspace is touched.
Then set RETRIEVAL_ENABLED=true in the backend's .env and restart the backend.
#>
param(
    [string]$Quantizer = "",
    [int]$CassandraPort = 9042,
    [string]$Keyspace = "smdb",
    [int]$Port = 8100,
    [string]$Pool = "centroid"
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$py = ".venv\Scripts\python.exe"

if (-not $Quantizer) {
    $found = Get-ChildItem data -Filter "quantizer_book_*answerai_colbert_small_v1_*.npz" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $found) {
        throw "No trained quantizer found in data\. Run scripts\index_book.py on a textbook first, or pass -Quantizer <file.npz>."
    }
    $Quantizer = $found.FullName
}

$info = & $py -m smdb.cli --port $CassandraPort --keyspace $Keyspace info
if ($info -match "no quantizer stored") {
    Write-Host "Storing quantizer $Quantizer in Cassandra keyspace '$Keyspace' ..."
    & $py -m smdb.cli --port $CassandraPort --keyspace $Keyspace load --file $Quantizer
} else {
    Write-Host "Quantizer already stored: $info"
}

$env:SMDB_STORE = "cassandra"
$env:SMDB_PORT = "$CassandraPort"
$env:SMDB_KEYSPACE = $Keyspace
$env:SMDB_MODEL = "answerdotai/answerai-colbert-small-v1"
$env:SMDB_MARKERS = "colbert"
$env:SMDB_POOL = $Pool
Write-Host "Starting sidecar on http://127.0.0.1:$Port  (Ctrl+C to stop)"
& $py -m uvicorn smdb.service:app --host 127.0.0.1 --port $Port

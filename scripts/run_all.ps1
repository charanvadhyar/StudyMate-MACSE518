# Sets up the environment and runs every check, writing all output to run_log.txt.
# From the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\run_all.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\run_all.ps1 -SkipBench      (setup + tests only)
#   powershell -ExecutionPolicy Bypass -File scripts\run_all.ps1 -CassandraBench (also benchmark on Cassandra)
param([switch]$SkipBench, [switch]$CassandraBench)

$ErrorActionPreference = "Continue"
$log = Join-Path (Get-Location) "run_log.txt"
"run started $(Get-Date -Format s)" | Out-File -FilePath $log -Encoding utf8

function Say($text) {
    "`n===== $text =====" | Tee-Object -FilePath $log -Append
}
function Run($exe, [string[]]$arguments) {
    "> $exe $($arguments -join ' ')" | Tee-Object -FilePath $log -Append
    & $exe @arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log -Append
    "exit code: $LASTEXITCODE" | Tee-Object -FilePath $log -Append
}

Say "1. Python environment"
if (-not (Test-Path ".venv\Scripts\python.exe")) {
    if (Get-Command py -ErrorAction SilentlyContinue) { Run "py" @("-3.11", "-m", "venv", ".venv") }
    if (-not (Test-Path ".venv\Scripts\python.exe")) { Run "python" @("-m", "venv", ".venv") }
}
$py = (Resolve-Path ".venv\Scripts\python.exe").Path
Run $py @("--version")
Run $py @("-m", "pip", "install", "-q", "--upgrade", "pip")
Run $py @("-m", "pip", "install", "-q", "-e", ".[encoder,bench,dev]")

Say "2. Rust kernel (optional)"
if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Run $py @("-m", "pip", "install", "-q", "maturin")
    Push-Location kernel
    $env:VIRTUAL_ENV = (Resolve-Path "..\.venv").Path
    Run $py @("-m", "maturin", "develop", "--release")
    Pop-Location
} else {
    "cargo not found: skipping, the NumPy fallback will be used" | Tee-Object -FilePath $log -Append
}
Run $py @("-c", "from smdb.scorer import HAVE_KERNEL; print('rust kernel loaded:', HAVE_KERNEL)")

Say "3. Tests, in-memory store"
Run $py @("-m", "pytest", "-q")

Say "4. Cassandra"
$probe = "import sys`nfrom cassandra.cluster import Cluster`ntry:`n    c = Cluster(['127.0.0.1']); s = c.connect(); print('cassandra', s.execute('SELECT release_version FROM system.local').one()[0]); c.shutdown()`nexcept Exception as e:`n    print('not reachable:', type(e).__name__); sys.exit(1)"
& $py -c $probe 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    "nothing answering on 127.0.0.1:9042, starting the compose service" | Tee-Object -FilePath $log -Append
    Run "docker" @("compose", "up", "-d")
    for ($i = 0; $i -lt 36; $i++) {
        Start-Sleep -Seconds 10
        & $py -c $probe 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
    }
}
Run $py @("-c", $probe)
$cassandraUp = ($LASTEXITCODE -eq 0)

if ($cassandraUp) {
    Say "5. Tests, Cassandra store"
    $env:SMDB_TEST_CASSANDRA = "127.0.0.1"
    Run $py @("-m", "pytest", "-q")
    Remove-Item Env:\SMDB_TEST_CASSANDRA
} else {
    Say "5. Cassandra not reachable: store tests skipped"
}

if (-not $SkipBench) {
    Say "6. SciFact benchmark, in-memory store (first run encodes the corpus; slow on CPU)"
    Run $py @("scripts\bench.py", "--dataset", "beir/scifact/test")
    if ($CassandraBench -and $cassandraUp) {
        Say "7. SciFact benchmark, Cassandra store"
        Run $py @("scripts\bench.py", "--dataset", "beir/scifact/test", "--store", "cassandra")
    }
}

Say "done $(Get-Date -Format s)"
"Log written to $log"

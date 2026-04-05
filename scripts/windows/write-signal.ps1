$bridgeFile = Join-Path $env:USERPROFILE ".claude\notify-path"
$projectPath = (Get-Content $bridgeFile -Raw).Trim()
$signalDir = Join-Path $projectPath ".vscode"
if (-not (Test-Path $signalDir)) { New-Item -ItemType Directory -Path $signalDir -Force | Out-Null }
$signalPath = Join-Path $signalDir ".claude-focus"

$id = $PID
$lines = @()
while ($id -and $id -gt 0) {
    $lines += "$id"
    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $id" -EA SilentlyContinue).ParentProcessId
    if (-not $parent -or $parent -eq $id -or $parent -eq 0) { break }
    $id = $parent
}
[System.IO.File]::WriteAllText($signalPath, ($lines -join "`n"))

param(
  [Parameter(Mandatory = $true)] [int] $Port,
  [string] $Name = "port"
)

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)

if ($processIds.Count -eq 0) {
  Write-Host "[port] $Name port 127.0.0.1:$Port is free."
  exit 0
}

Write-Host "[port] clearing $Name port 127.0.0.1:$Port, used by:"
foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host "  PID $processId $($process.ProcessName) $($process.Path)"
  } else {
    Write-Host "  PID $processId"
  }
}

foreach ($processId in $processIds) {
  Write-Host "[port] stopping PID $processId..."
  Stop-Process -Id $processId -Force -ErrorAction Stop
}

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 250
  $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $stillListening) {
    Write-Host "[port] Port $Port is free."
    exit 0
  }
}

Write-Error "Port $Port is still in use after stopping listener(s)."
exit 1

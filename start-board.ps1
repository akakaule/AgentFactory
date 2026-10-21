[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 8787 }),
  [string]$Database = 'agentfactory.db',
  [switch]$Build
)

$ErrorActionPreference = 'Stop'
$previousAuthMode = $env:AUTH_MODE
$previousPort = $env:PORT
$previousDatabase = $env:AGENTFACTORY_DB
Push-Location -LiteralPath $PSScriptRoot
try {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    $processIds = ($listener.OwningProcess | Sort-Object -Unique) -join ', '
    throw "Port $Port is already in use (PID $processIds). Stop the existing board in its terminal first, or choose another port with -Port."
  }

  if ($Build -or -not (Test-Path 'packages/web/server/dist/index.js') -or -not (Test-Path 'packages/web/client/dist/index.html')) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Board build failed.' }
  }

  # Set this explicitly even in terminals opened before the user setting was saved.
  $env:AUTH_MODE = 'token'
  $env:PORT = [string]$Port
  $env:AGENTFACTORY_DB = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Database)
  Write-Host "Starting board at http://localhost:$Port with token authentication."
  Write-Host "Database: $env:AGENTFACTORY_DB"
  Write-Host 'Use your board login token in the browser. Press Ctrl+C to stop.'
  & node packages/web/server/dist/index.js
  if ($LASTEXITCODE -ne 0) { throw "Board exited with code $LASTEXITCODE." }
} finally {
  $env:AUTH_MODE = $previousAuthMode
  $env:PORT = $previousPort
  $env:AGENTFACTORY_DB = $previousDatabase
  Pop-Location
}

# Portable production build: a folder that runs on a Windows PC with no Node.js
# installed and no admin rights. It carries the official node.exe (zip
# distribution, nothing to install), the orchestrator compiled to plain JS, the
# workspace packages' dist, the production npm dependencies and the UI bundle.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 [-OutDir <dir>] [-NodeVersion v22.x.y]
#
# Output: <OutDir>\simrs-flow-portable\ (start.bat, config.env, node\, app\) and a zip
# next to it. Run on the target PC with start.bat; open the printed LAN URL.
# ponytail: plain folder + zip; an installer or service wrapper only if IT asks for one.
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\.portable'),
  [string]$NodeVersion = 'v22.23.4'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$stage = Join-Path $OutDir 'simrs-flow-portable'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Force $app | Out-Null

Write-Host '[portable] building packages + UI bundle'
Push-Location $root
try {
  # QA login bypass must never be baked into a bundle that leaves this PC.
  $env:VITE_QA_AUTH = $null
  npm run build | Out-Host
  if ($LASTEXITCODE) { throw 'npm run build failed' }

  Write-Host '[portable] compiling orchestrator to JS'
  # The base config maps @simrs-flow/* to package sources (for dev); here they must
  # resolve to the built dist, which is what the copied packages ship.
  $tsconfig = Join-Path $OutDir 'tsconfig.orchestrator.json'
  [ordered]@{
    extends = (Join-Path $root 'apps\orchestrator\tsconfig.json')
    compilerOptions = [ordered]@{ noEmit = $false; paths = @{}; rootDir = (Join-Path $root 'apps\orchestrator\src'); outDir = (Join-Path $app 'apps\orchestrator\dist'); sourceMap = $false }
    # Globs need forward slashes.
    include = @(($root -replace '\\', '/') + '/apps/orchestrator/src/**/*.ts')
    exclude = @(($root -replace '\\', '/') + '/apps/orchestrator/src/**/*.test.ts')
  } | ConvertTo-Json -Depth 4 | Set-Content $tsconfig -Encoding utf8
  npx tsc -p $tsconfig | Out-Host
  if ($LASTEXITCODE) { throw 'orchestrator compile failed' }
} finally { Pop-Location }

# UI where main.ts looks by default: <orchestrator dist>\..\..\ui\dist
Copy-Item -Recurse (Join-Path $root 'apps\ui\dist') (Join-Path $app 'apps\ui\dist')

Write-Host '[portable] installing production dependencies'
# Exact versions of what the repo runs today; workspace packages are copied in below, not installed.
$deps = [ordered]@{}
foreach ($dir in @('apps\orchestrator') + (Get-ChildItem (Join-Path $root 'packages') -Directory | ForEach-Object { "packages\$($_.Name)" })) {
  $pkg = Get-Content (Join-Path $root "$dir\package.json") -Raw | ConvertFrom-Json
  if (-not $pkg.dependencies) { continue }
  foreach ($name in $pkg.dependencies.PSObject.Properties.Name) {
    if ($name -like '@simrs-flow/*') { continue }
    $deps[$name] = (Get-Content (Join-Path $root "node_modules\$name\package.json") -Raw | ConvertFrom-Json).version
  }
}
[ordered]@{ name = 'simrs-flow-portable'; private = $true; type = 'module'; dependencies = $deps } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $app 'package.json') -Encoding utf8
Push-Location $app
try {
  npm install --omit=dev --no-audit --no-fund --loglevel=error | Out-Host
  if ($LASTEXITCODE) { throw 'npm install failed' }
} finally { Pop-Location }

# Workspace packages as real folders (no symlinks/junctions: they do not survive a zip).
foreach ($p in Get-ChildItem (Join-Path $root 'packages') -Directory) {
  $dest = Join-Path $app "node_modules\@simrs-flow\$($p.Name)"
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item (Join-Path $p.FullName 'package.json') $dest
  Copy-Item -Recurse (Join-Path $p.FullName 'dist') (Join-Path $dest 'dist')
}

Write-Host "[portable] fetching node $NodeVersion (win-x64 zip)"
$nodeZip = Join-Path $OutDir "node-$NodeVersion-win-x64.zip"
if (-not (Test-Path $nodeZip)) { Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $nodeZip }
$sums = (Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt").Content
$want = ($sums -split "`n" | Where-Object { $_ -match "node-$NodeVersion-win-x64\.zip$" }) -replace '\s.*$', ''
$got = (Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLower()
if ($want -ne $got) { throw "node zip checksum mismatch: $got vs $want" }
$nodeTmp = Join-Path $OutDir 'node-extract'
if (Test-Path $nodeTmp) { Remove-Item -Recurse -Force $nodeTmp }
Expand-Archive $nodeZip $nodeTmp
New-Item -ItemType Directory -Force (Join-Path $stage 'node') | Out-Null
Copy-Item (Join-Path $nodeTmp "node-$NodeVersion-win-x64\node.exe") (Join-Path $stage 'node')
Copy-Item (Join-Path $nodeTmp "node-$NodeVersion-win-x64\LICENSE") (Join-Path $stage 'node')
Remove-Item -Recurse -Force $nodeTmp

# CRLF for cmd.exe, whatever line endings the checkout has.
(Get-Content (Join-Path $PSScriptRoot 'portable\start.bat')) -join "`r`n" | Set-Content (Join-Path $stage 'start.bat') -NoNewline -Encoding ascii
# config.env, not .env: Compress-Archive drops dot-files, and Explorer users find it easier.
# A gitignored portable\config.local.env (site URLs) wins over the public template.
$cfg = Join-Path $PSScriptRoot 'portable\config.local.env'
if (-not (Test-Path $cfg)) { $cfg = Join-Path $PSScriptRoot 'portable\config.env' }
Copy-Item $cfg (Join-Path $stage 'config.env')
Copy-Item (Join-Path $PSScriptRoot 'portable\BACA-SAYA.txt') $stage
$sha = (git -C $root rev-parse --short HEAD).Trim()
"simrs-flow portable @ $sha, node $NodeVersion, built $(Get-Date -Format s)" | Set-Content (Join-Path $stage 'VERSION.txt')

$zip = Join-Path $OutDir "simrs-flow-portable-$sha.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $stage -DestinationPath $zip
Write-Host "[portable] done: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"

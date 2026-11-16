param([switch]$PanelOnly)
$ErrorActionPreference = 'Stop'

$pulseNode = Get-Command node -ErrorAction SilentlyContinue
$usedHostElectron = $false
$prevElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
if (-not $pulseNode) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Antigravity\Antigravity.exe'),
    (Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe')
  )
  $hostExe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
  if ($hostExe) {
    $usedHostElectron = $true
    $pulseNode = @{ Source = $hostExe }
  }
}

$manageMjs = Join-Path $PSScriptRoot 'manage.mjs'
if ($pulseNode -and (Test-Path -LiteralPath $manageMjs -PathType Leaf)) {
  $pulseArguments = @($manageMjs, 'install')
  if ($PanelOnly) { $pulseArguments += '--panel-only' }
  try {
    if ($usedHostElectron) { $env:ELECTRON_RUN_AS_NODE = '1' }
    & $pulseNode.Source @pulseArguments
    if ($LASTEXITCODE -ne 0) { throw 'Antigrative Dashboard installation failed. See the error above.' }
  } finally {
    if ($usedHostElectron) { $env:ELECTRON_RUN_AS_NODE = $prevElectronRunAsNode }
  }
  exit 0
}

$pulsePython = Get-Command python -ErrorAction SilentlyContinue
if (-not $pulsePython) { throw 'Node.js 20+ or Python 3.10+ is required. Install Node.js or Python, then run this script again.' }
$pulseArguments = @((Join-Path $PSScriptRoot 'manage.py'), 'install')
if ($PanelOnly) { $pulseArguments += '--panel-only' }
& $pulsePython.Source @pulseArguments
if ($LASTEXITCODE -ne 0) { throw 'Antigrative Dashboard installation failed. See the error above.' }

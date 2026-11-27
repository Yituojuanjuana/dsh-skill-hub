#Requires -Version 5.1
<#
  dsh-restart-body.ps1 — restart 的实际执行体（由 dsh-control.ps1 的 detached 启动器调用）。

  收编自原 dsh-restart.ps1 的全部逻辑：优雅关闭（WM_CLOSE 让 Electron 刷会话与凭据）
  → 必要时强制结束 → 重新拉起 → 等 ingress 端口回来。

  为什么单独一个文件：`restart` 必须「先返回 202，再延时执行」，所以调用链是
  dsh-control.ps1（立即返回）→ detached 启动器（sleep N）→ 本文件（真正干活）。
  本文件不写审计日志（父脚本已经写了「已接受」），只把过程写进 dsh-control.log
  以便事后核对，绝不影响退出码。
#>

$ErrorActionPreference = 'Continue'

$Root        = 'C:\Users\67549\.dsh\cloudflared'
$AuditLog    = Join-Path $Root 'dsh-control.log'
$AppExe      = 'D:\AAAAA\DeepSeek Harness\DeepSeek Harness.exe'
$IngressPort = 53870
$CloseWait   = 25
$BootWait    = 180

function Write-Audit {
  param([string]$Message)
  $line = '{0} [restart-body] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -LiteralPath $AuditLog -Value $line -Encoding UTF8 } catch { }
}

function Test-Ingress {
  try {
    $c = @(Get-NetTCPConnection -LocalPort $IngressPort -State Listen -ErrorAction Stop)
    return ($c.Count -gt 0)
  } catch { return $false }
}

function Get-DshProcesses {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' })
}

function Get-DshRoot {
  param($All)
  $dsh = @($All | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' })
  if ($dsh.Count -eq 0) { return $null }
  foreach ($p in $dsh) {
    $parent = $All | Where-Object { $_.ProcessId -eq $p.ParentProcessId } | Select-Object -First 1
    if ($parent -ne $null -and $parent.Name -eq 'explorer.exe') { return $p }
  }
  return ($dsh | Sort-Object CreationDate | Select-Object -First 1)
}

Write-Audit '[START] restart body invoked'

$all  = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$dshProc = Get-DshRoot -All $all
if ($dshProc -eq $null) {
  Write-Audit '[SKIP] DSH is already closed; a closed app is a user decision, not a fault'
  exit 0
}
Write-Audit ('[INFO] DSH root pid={0} started={1}' -f $dshProc.ProcessId, $dshProc.CreationDate)

if (-not (Test-Path -LiteralPath $AppExe)) {
  Write-Audit ('[ERROR] app executable not found: ' + $AppExe)
  exit 1
}

# ---- graceful close --------------------------------------------------------

$closed = $false
try {
  $proc = Get-Process -Id $dshProc.ProcessId -ErrorAction Stop
  $closed = $proc.CloseMainWindow()
  Write-Audit ('[CLOSE] CloseMainWindow returned {0}' -f $closed)
} catch {
  Write-Audit ('[CLOSE] CloseMainWindow failed: ' + $_.Exception.Message)
}

$deadline = (Get-Date).AddSeconds($CloseWait)
while ((Get-Date) -lt $deadline) {
  if ((Get-DshProcesses).Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}

$left = @(Get-DshProcesses)
if ($left.Count -gt 0) {
  Write-Audit ('[CLOSE] {0} process(es) still alive after graceful close, forcing' -f $left.Count)
  foreach ($p in $left) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
  }
  Start-Sleep -Seconds 3
}

if ((Get-DshProcesses).Count -gt 0) {
  Write-Audit '[ERROR] DSH would not exit; aborting restart instead of starting a second instance'
  exit 1
}
Write-Audit '[CLOSE] DSH is fully stopped'

# ---- relaunch ---------------------------------------------------------------

try {
  $launched = Start-Process -FilePath $AppExe -WorkingDirectory (Split-Path -Parent $AppExe) -PassThru
  Write-Audit ('[LAUNCH] started DSH pid={0}' -f $launched.Id)
} catch {
  Write-Audit ('[ERROR] relaunch failed: ' + $_.Exception.Message)
  exit 1
}

# ---- wait for the mobile ingress to come back -------------------------------

$ok = $false
$deadline = (Get-Date).AddSeconds($BootWait)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Test-Ingress) { $ok = $true; break }
}

if ($ok) {
  Write-Audit ('[OK] ingress {0} is listening again' -f $IngressPort)
} else {
  Write-Audit ('[WARN] ingress {0} did not come back within {1}s; the plugin may be missing' -f $IngressPort, $BootWait)
}

Write-Audit '[DONE] restart body finished'
if ($ok) { exit 0 } else { exit 2 }

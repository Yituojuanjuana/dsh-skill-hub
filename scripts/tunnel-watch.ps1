#Requires -Version 5.1
<#
  DSH tunnel watchdog（0.7.0 起：只做节律与退避，不自己做隧道修复）

  职责收窄成两件事：
    1. 30 秒一次的节律 + 失败退避（这是本脚本唯一还独占的逻辑）；
    2. 每个周期调用 dsh-control.ps1 heal，由它判断并执行最小修复。

  为什么这样改：原来本脚本里有一整套「起 cloudflared / 解析日志拿地址 / 健康检查 /
  重建隧道 / 推 endpoint.txt」的重复实现，和 dsh-restart.ps1 各写一份，两边都会起
  cloudflared —— 于是偶尔出现两个隧道进程抢同一个 --url。现在执行体只有
  dsh-control.ps1 一个，本脚本不再 Start-Process cloudflared，也不会再写出第二个。

  保留的原有行为：
    - 单实例锁（tunnel-watch.lock），并识别「锁里的 pid 已经不是 watchdog」的陈旧锁；
    - 30 秒节律（$IntervalSec）；
    - 连续失败退避（$FailLimit 次后把间隔拉长到 $BackoffSec）；
    - 永不因单次异常退出。
#>
param(
  [switch]$Once,
  # 只打印将要做的事，不真的调用 heal（改造后的自检用）。
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

$Root        = 'C:\Users\67549\.dsh\cloudflared'
$WatchLog    = Join-Path $Root 'tunnel-watch.log'
$LockFile    = Join-Path $Root 'tunnel-watch.lock'
$Control     = Join-Path $Root 'dsh-control.ps1'
$IntervalSec = 30
$FailLimit   = 3
$BackoffSec  = 120

$script:Failures = 0

function Write-WatchLog {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -LiteralPath $WatchLog -Value $line -Encoding UTF8 } catch { }
}

function Test-WatchdogHolder {
  param([int]$CandidatePid)
  if ($CandidatePid -le 0) { return $false }
  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $CandidatePid) -ErrorAction SilentlyContinue
  if ($proc -eq $null) { return $false }
  $cmd = [string]$proc.CommandLine
  # 光有活着的 pid 不够：重启后记录下来的 pid 可能属于无关进程，
  # 把它当持有者会让 watchdog 永远拒绝启动。
  return ($cmd -like '*tunnel-watch.ps1*')
}

function Acquire-Lock {
  if (Test-Path -LiteralPath $LockFile) {
    $raw = ''
    try { $raw = (Get-Content -LiteralPath $LockFile -Raw -ErrorAction Stop).Trim() } catch { }
    $otherPid = 0
    if ([int]::TryParse($raw, [ref]$otherPid) -and $otherPid -gt 0) {
      if (Test-WatchdogHolder -CandidatePid $otherPid) { return $false }
      Write-WatchLog ('[LOCK] stale lock from pid={0} (not a live watchdog), taking over' -f $otherPid)
    }
  }
  try {
    [System.IO.File]::WriteAllText($LockFile, [string]$PID, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
  return $true
}

<# 调 heal 并解析它输出的 JSON。失败只记日志、返回 $null，绝不抛给主循环。 #>
function Invoke-Heal {
  if ($DryRun) {
    Write-WatchLog '[DRYRUN] would call: dsh-control.ps1 heal -Actor watchdog'
    return @{ ok = $true; command = 'heal'; dryRun = $true; changed = $false; message = 'dry run' }
  }
  if (-not (Test-Path -LiteralPath $Control)) {
    Write-WatchLog ('[ERROR] control script missing: ' + $Control)
    return $null
  }
  try {
    $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File $Control heal -Actor watchdog 2>&1 | Out-String)
    $flat = ($out.Trim() -replace '\s+', ' ')
    # stdout 只有一行 JSON；PowerShell 自己的警告可能混进来，所以从第一个 { 开始截。
    $start = $flat.IndexOf('{')
    if ($start -lt 0) {
      Write-WatchLog ('[HEAL] no JSON in output: ' + $flat.Substring(0, [Math]::Min(240, $flat.Length)))
      return $null
    }
    $json = $flat.Substring($start)
    $end = $json.LastIndexOf('}')
    if ($end -ge 0) { $json = $json.Substring(0, $end + 1) }
    return ($json | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    Write-WatchLog ('[HEAL] call failed: ' + $_.Exception.Message)
    return $null
  }
}

function Invoke-Cycle {
  $result = Invoke-Heal
  if ($result -eq $null) {
    $script:Failures++
    Write-WatchLog ('[HEAL] failure {0}/{1}' -f $script:Failures, $FailLimit)
    return
  }
  if ($script:Failures -gt 0) {
    Write-WatchLog ('[HEAL] recovered after {0} failure(s)' -f $script:Failures)
    $script:Failures = 0
  }
  $changed = $false
  try { $changed = [bool]$result.changed } catch { }
  if ($changed) {
    Write-WatchLog ('[HEAL] repaired: ' + [string]$result.message)
  }
}

if (-not (Acquire-Lock)) {
  $holder = ''
  try { $holder = (Get-Content -LiteralPath $LockFile -Raw).Trim() } catch { }
  Write-WatchLog ('[LOCK] another watchdog is running (pid=' + $holder + '), exiting')
  exit 0
}

Write-WatchLog ('[START] watchdog started pid=' + $PID + $(if ($DryRun) { ' (dry run)' } else { '' }))
try {
  if ($Once) {
    try { Invoke-Cycle } catch {
      Write-WatchLog ('[ERROR] cycle failed: ' + $_.Exception.Message)
    }
  } else {
    while ($true) {
      try { Invoke-Cycle } catch {
        Write-WatchLog ('[ERROR] cycle failed: ' + $_.Exception.Message)
        Start-Sleep -Seconds 10
      }
      $wait = $IntervalSec
      if ($script:Failures -ge $FailLimit) {
        $wait = $BackoffSec
        Write-WatchLog ('[BACKOFF] {0} consecutive failures, waiting {1}s' -f $script:Failures, $wait)
      }
      Start-Sleep -Seconds $wait
    }
  }
} finally {
  try { Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue } catch { }
}

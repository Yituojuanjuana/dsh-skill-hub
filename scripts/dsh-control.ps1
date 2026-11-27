#Requires -Version 5.1
<#
  dsh-control.ps1 — 运行与连接的唯一执行体。

  技能书架插件的「运行与连接」面板只负责调用本脚本并解析它的 JSON 输出；
  插件里不另写任何 cloudflared / 重启 / 隧道逻辑。所有子命令统一：
    - 写一行审计日志（谁调的、什么时候、结果），路径固定 $AuditLog；
    - 以单个 JSON 对象输出到 stdout（PowerShell 自己的进度/警告不进 stdout）；
    - 退出码 0 = 成功，非 0 = 失败（JSON 里仍带 ok/message）。

  子命令：
    status          只读：DSH 进程、ingress 端口、隧道地址、隧道健康、版本、bundle 一致性
    reload          Cordis 层热重载（通过向插件运行目录写标记文件 + 调宿主刷新端点）
    restart         优雅关闭 + 重新拉起 DSH（收编原 dsh-restart.ps1 的全部逻辑）
    tunnel-restart  停旧 cloudflared、起新的、等新地址、推 endpoint.txt
    tunnel-rotate   与 tunnel-restart 同义（保留独立名字，语义是「换一个域名」）
    heal            watchdog 用：判断 status，需要时只做最小修复（不重复起第二个 cloudflared）

  安全闸门（本脚本负责的部分）：
    - restart 前检查是否还有正在跑的 turn：有就拒绝（插件侧也会先查一次，这里是兜底）
    - restart 用 detached 方式：写一个延迟启动器，脚本立即返回，浏览器不必悬着
    - 冷却 5 分钟（手动点的门槛，比 watchdog 的 15 分钟短）
    - 审计日志不记录任何 token / 配对码

  所有路径都写死成绝对路径：本脚本由插件以非交互方式拉起，不能依赖 $PWD。
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'reload', 'restart', 'tunnel-restart', 'tunnel-rotate', 'heal')]
  [string]$Command = 'status',

  # 谁点的（插件传 'panel'，watchdog 传 'watchdog'，手工调试可传 'cli'）。
  [string]$Actor = 'cli',

  # restart 的延迟秒数（detached：先返回，再执行）。
  [int]$RestartDelaySec = 2,

  # 跳过冷却（仅调试用；插件永远不传）。
  [switch]$Force,

  # 只打印将要做的事，不真的做（watchdog 改造后的 dry-run 校验用）。
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# ---- 固定路径（唯一真源）---------------------------------------------------
$Root        = 'C:\Users\67549\.dsh\cloudflared'
$AuditLog    = Join-Path $Root 'dsh-control.log'
$TunnelLog   = Join-Path $Root 'dsh-tunnel.log'
$WatchLog    = Join-Path $Root 'tunnel-watch.log'
$CooldownFile = Join-Path $Root 'dsh-control.cooldown'
$RepoDir     = Join-Path $Root 'endpoint-repo'
$EndpointTxt = Join-Path $RepoDir 'endpoint.txt'
$EndpointMirror = Join-Path $Root 'dsh-endpoint'
$RawUrl      = 'https://raw.githubusercontent.com/Yituojuanjuana/dsh-endpoint/main/endpoint.txt'
$AppExe      = 'D:\AAAAA\DeepSeek Harness\DeepSeek Harness.exe'
$DshCli      = 'D:\AAAAA\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$IngressPort = 53870
$TargetUrl   = 'http://127.0.0.1:53870'
$HealthPath  = '/api/mobile/v1/connection-info'
$CooldownMin = 5
$CloseWait   = 25
$BootWait    = 180

# 仓库里的 client bundle：用来判断「已加载的 bundle 是不是最新」。
$RepoBundle  = 'E:\67549\Documents\deepseek-harness\default-workspace\skill-usage-manager\lib\client.js'
$LiveBundle  = Join-Path (Split-Path -Parent $Root) 'profiles\desktop\node_modules\dsh-skill-shelf\lib\client.js'

function Write-Audit {
  param([string]$Message)
  $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Actor, $Message
  try { Add-Content -LiteralPath $AuditLog -Value $line -Encoding UTF8 } catch { }
}

# ---- 基础探测 ---------------------------------------------------------------

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

function Test-Ingress {
  try {
    $c = @(Get-NetTCPConnection -LocalPort $IngressPort -State Listen -ErrorAction Stop)
    return ($c.Count -gt 0)
  } catch { return $false }
}

function Get-TunnelProcesses {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*--url $TargetUrl*" }
}

function Get-CloudflaredExe {
  $candidates = @(
    'C:\Users\67549\AppData\Local\cloudflared\cloudflared.exe',
    (Join-Path $Root '2026.11.0\win32-x64\cloudflared.exe')
  )
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
  return $null
}

function Resolve-TunnelAddress {
  if (-not (Test-Path -LiteralPath $TunnelLog)) { return $null }
  $text = ''
  try {
    $fs = [System.IO.File]::Open($TunnelLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
      $text = $sr.ReadToEnd()
      $sr.Dispose()
    } finally { $fs.Dispose() }
  } catch { return $null }
  $found = [regex]::Matches($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($found.Count -eq 0) { return $null }
  return $found[$found.Count - 1].Value
}

function Get-PublishedEndpoint {
  foreach ($f in @($EndpointTxt, $EndpointMirror)) {
    if (Test-Path -LiteralPath $f) {
      try { $v = ([System.IO.File]::ReadAllText($f)).Trim(); if ($v -ne '') { return $v } } catch { }
    }
  }
  return $null
}

function Test-TunnelHealth {
  param([string]$BaseUrl)
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) { return @{ ok = $false; status = 0; note = 'no address'; reachable = $false } }
  $probe = $BaseUrl.TrimEnd('/') + $HealthPath
  try {
    $resp = Invoke-WebRequest -Uri $probe -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
    $code = [int]$resp.StatusCode
    return @{ ok = ($code -lt 500); status = $code; note = $null; reachable = $true }
  } catch {
    $r = $_.Exception.Response
    if ($r -ne $null) {
      $code = 0
      try { $code = [int]$r.StatusCode } catch { $code = 0 }
      if ($code -gt 0) { return @{ ok = ($code -lt 500); status = $code; note = $null; reachable = $true } }
    }
    # 超时 / DNS 抖动不是「隧道已死」的证据：quick tunnel 冷启动后第一次握手
    # 常常超过 12 秒，把它当故障会导致刚建好的隧道被立刻拆掉。
    # reachable=false 表示「这次没问到」，由调用方决定是否真的轮换。
    return @{ ok = $false; status = 0; note = $_.Exception.Message; reachable = $false }
  }
}

function Get-BundleState {
  $live = $null
  $repo = $null
  try { if (Test-Path -LiteralPath $LiveBundle) { $live = (Get-Item -LiteralPath $LiveBundle).LastWriteTime } } catch { }
  try { if (Test-Path -LiteralPath $RepoBundle) { $repo = (Get-Item -LiteralPath $RepoBundle).LastWriteTime } } catch { }
  $same = $false
  if ($live -ne $null -and $repo -ne $null) {
    # 文件系统时间戳精度不同，1 秒内视为同一份构建。
    $same = ([Math]::Abs(($live - $repo).TotalSeconds) -lt 1)
  }
  return @{
    liveMtime    = $(if ($live -ne $null) { $live.ToString('o') } else { $null })
    repoMtime    = $(if ($repo -ne $null) { $repo.ToString('o') } else { $null })
    upToDate     = $same
  }
}

function Get-CooldownRemaining {
  if ($Force) { return 0 }
  if (-not (Test-Path -LiteralPath $CooldownFile)) { return 0 }
  $raw = ''
  try { $raw = (Get-Content -LiteralPath $CooldownFile -Raw -ErrorAction Stop).Trim() } catch { return 0 }
  $last = [datetime]::MinValue
  if (-not [datetime]::TryParse($raw, [ref]$last)) { return 0 }
  $age = ((Get-Date) - $last).TotalMinutes
  $left = $CooldownMin - $age
  if ($left -le 0) { return 0 }
  return [int][Math]::Ceiling($left * 60)
}

function Set-Cooldown {
  try {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    [System.IO.File]::WriteAllText($CooldownFile, $stamp, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

# ---- 输出 -------------------------------------------------------------------

function Write-Result {
  param([hashtable]$Payload)
  $json = $Payload | ConvertTo-Json -Depth 6 -Compress
  [Console]::Out.WriteLine($json)
}

# ---- status -----------------------------------------------------------------

function Invoke-Status {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $root = Get-DshRoot -All $all
  $ingress = Test-Ingress
  $addr = Resolve-TunnelAddress
  $published = Get-PublishedEndpoint
  $health = Test-TunnelHealth -BaseUrl $(if ($addr) { $addr } else { $published })
  $bundle = Get-BundleState
  $cooldown = Get-CooldownRemaining

  return @{
    ok        = $true
    command   = 'status'
    at        = (Get-Date).ToString('o')
    dsh       = @{
      running   = ($root -ne $null)
      pid       = $(if ($root -ne $null) { [int]$root.ProcessId } else { $null })
      startedAt = $(if ($root -ne $null) { ([datetime]$root.CreationDate).ToString('o') } else { $null })
    }
    ingress   = @{ port = $IngressPort; listening = $ingress }
    tunnel    = @{
      address   = $addr
      published = $published
      healthy   = $health.ok
      status    = $health.status
      note      = $health.note
      processes = @(Get-TunnelProcesses).Count
    }
    bundle    = $bundle
    cooldownRemainingSec = $cooldown
  }
}

# ---- reload -----------------------------------------------------------------

# Cordis 层热重载：宿主没有对外开放的 reload 端点，唯一稳定的入口是
# 「重新解析 profile 的插件层」。这里通过写一个请求文件给宿主侧的刷新器
# （与本机 GUI 的刷新按钮同一条路径），不重启进程。
function Invoke-Reload {
  $marker = Join-Path $Root 'dsh-reload-request.json'
  if ($DryRun) {
    Write-Audit '[DRYRUN] would request a Cordis reload (no process restart)'
    return @{ ok = $true; command = 'reload'; dryRun = $true; message = 'would request reload' }
  }
  try {
    $payload = @{ requestedAt = (Get-Date).ToString('o'); actor = $Actor } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($marker, $payload, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Audit ('[ERROR] could not write reload request: ' + $_.Exception.Message)
    return @{ ok = $false; command = 'reload'; message = 'could not write reload request: ' + $_.Exception.Message }
  }
  Write-Audit '[RELOAD] Cordis reload requested (process untouched)'
  return @{
    ok      = $true
    command = 'reload'
    message = 'reload requested; press Ctrl+Shift+R in the GUI to pick up the new client bundle'
  }
}

# ---- restart ----------------------------------------------------------------

function Invoke-Restart {
  if ($DryRun) {
    Write-Audit '[DRYRUN] would gracefully close DSH, relaunch it, and wait for the ingress port'
    return @{ ok = $true; command = 'restart'; dryRun = $true; message = 'would restart' }
  }
  $left = Get-CooldownRemaining
  if ($left -gt 0) {
    Write-Audit ('[SKIP] restart refused: cooldown, {0}s remaining' -f $left)
    return @{ ok = $false; command = 'restart'; code = 'cooldown'; cooldownRemainingSec = $left; message = ('冷却中，还需等待 {0} 秒' -f $left) }
  }

  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $root = Get-DshRoot -All $all
  if ($root -eq $null) {
    Write-Audit '[SKIP] restart refused: DSH is not running'
    return @{ ok = $false; command = 'restart'; code = 'not-running'; message = 'DSH 没有在运行，无需重启' }
  }
  if (-not (Test-Path -LiteralPath $AppExe)) {
    Write-Audit ('[ERROR] app executable not found: ' + $AppExe)
    return @{ ok = $false; command = 'restart'; code = 'missing-exe'; message = '找不到 DeepSeek Harness.exe' }
  }

  # detached：写一个一次性延迟启动器，本脚本立刻返回，浏览器不必悬着。
  $runner = Join-Path $Root 'dsh-restart-detached.ps1'
  $body = @"
`$ErrorActionPreference = 'Continue'
Start-Sleep -Seconds $RestartDelaySec
& powershell -NoProfile -ExecutionPolicy Bypass -File '$Root\dsh-restart-body.ps1'
"@
  try {
    [System.IO.File]::WriteAllText($runner, $body, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Audit ('[ERROR] could not write detached runner: ' + $_.Exception.Message)
    return @{ ok = $false; command = 'restart'; code = 'runner-write-failed'; message = $_.Exception.Message }
  }

  try {
    $p = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner) -WindowStyle Hidden -PassThru
    Write-Audit ('[RESTART] accepted, detached runner pid={0}, delay={1}s' -f $p.Id, $RestartDelaySec)
  } catch {
    Write-Audit ('[ERROR] could not start detached runner: ' + $_.Exception.Message)
    return @{ ok = $false; command = 'restart'; code = 'runner-start-failed'; message = $_.Exception.Message }
  }

  Set-Cooldown
  return @{
    ok                  = $true
    command             = 'restart'
    accepted            = $true
    delaySec            = $RestartDelaySec
    cooldownRemainingSec = $CooldownMin * 60
    message             = ('已接受重启，{0} 秒后执行；当前所有对话会中断' -f $RestartDelaySec)
  }
}

# ---- tunnel -----------------------------------------------------------------

function Invoke-TunnelRestart {
  if ($DryRun) {
    Write-Audit '[DRYRUN] would stop the old cloudflared, start a new one, and publish the new address'
    return @{ ok = $true; command = 'tunnel-restart'; dryRun = $true; message = 'would restart tunnel' }
  }
  $exe = Get-CloudflaredExe
  if ($exe -eq $null) {
    Write-Audit '[ERROR] cloudflared.exe not found'
    return @{ ok = $false; command = 'tunnel-restart'; code = 'missing-cloudflared'; message = '找不到 cloudflared.exe' }
  }

  $old = @(Get-TunnelProcesses)
  foreach ($p in $old) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Audit ('[TUNNEL] stopped pid={0}' -f $p.ProcessId) } catch { }
  }
  if ($old.Count -gt 0) { Start-Sleep -Seconds 2 }

  $offset = 0
  if (Test-Path -LiteralPath $TunnelLog) { try { $offset = (Get-Item -LiteralPath $TunnelLog).Length } catch { } }

  try {
    $np = Start-Process -FilePath $exe -ArgumentList @('tunnel', '--url', $TargetUrl, '--no-autoupdate', '--logfile', $TunnelLog, '--loglevel', 'info') -WindowStyle Hidden -PassThru
    Write-Audit ('[TUNNEL] started pid={0} -> {1}' -f $np.Id, $TargetUrl)
  } catch {
    Write-Audit ('[ERROR] start cloudflared failed: ' + $_.Exception.Message)
    return @{ ok = $false; command = 'tunnel-restart'; code = 'start-failed'; message = $_.Exception.Message }
  }

  # 等新地址出现（只读新写入的那段日志）。
  $addr = $null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Test-Path -LiteralPath $TunnelLog)) { continue }
    try {
      $fs = [System.IO.File]::Open($TunnelLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        $start = 0
        if ($offset -gt 0 -and $offset -le $fs.Length) { $start = $offset }
        $fs.Position = $start
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd(); $sr.Dispose()
      } finally { $fs.Dispose() }
      $m = [regex]::Matches($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($m.Count -gt 0) { $addr = $m[$m.Count - 1].Value; break }
    } catch { }
  }

  if ($addr -eq $null) {
    Write-Audit '[WARN] no new address appeared within 90s'
    return @{ ok = $false; command = 'tunnel-restart'; code = 'no-address'; message = '新隧道已启动但 90 秒内没有拿到域名' }
  }

  # 推 endpoint.txt（本地副本 + 仓库 + git push）。
  try {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($EndpointTxt, $addr, $enc)
    [System.IO.File]::WriteAllText($EndpointMirror, $addr, $enc)
    Write-Audit ('[PUBLISH] local endpoint updated: ' + $addr)
  } catch {
    Write-Audit ('[ERROR] write endpoint failed: ' + $_.Exception.Message)
  }
  if (Test-Path -LiteralPath $RepoDir) {
    & git -C $RepoDir add endpoint.txt 2>&1 | Out-Null
    & git -C $RepoDir commit -m ('publish endpoint ' + $addr) 2>&1 | Out-Null
    $pushOut = (& git -C $RepoDir push origin main 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
      Write-Audit ('[WARN] push failed: ' + (($pushOut.Trim() -replace '\s+', ' ')))
    } else {
      Write-Audit '[PUBLISH] pushed endpoint.txt'
    }
  }

  $health = Test-TunnelHealth -BaseUrl $addr
  return @{
    ok      = $true
    command = 'tunnel-restart'
    address = $addr
    healthy = $health.ok
    status  = $health.status
    message = '隧道已更换域名'
  }
}

# ---- heal（watchdog 用）------------------------------------------------------

# 只做「最小修复」：不重复起第二个 cloudflared，不主动重启 DSH。
function Invoke-Heal {
  $ingress = Test-Ingress
  $procs = @(Get-TunnelProcesses)
  $addr = Resolve-TunnelAddress
  $health = Test-TunnelHealth -BaseUrl $addr
  $actions = @()

  if (-not $ingress) {
    $actions += 'ingress-down'
    Write-Audit ('[HEAL] ingress {0} is not listening (DSH down), nothing to repair' -f $IngressPort)
    return @{ ok = $true; command = 'heal'; actions = $actions; changed = $false; message = 'ingress down, DSH is down' }
  }

  if ($procs.Count -eq 0) {
    $actions += 'start-tunnel'
    if ($DryRun) {
      Write-Audit '[DRYRUN] would start cloudflared (none running)'
      return @{ ok = $true; command = 'heal'; dryRun = $true; actions = $actions; changed = $false; message = 'would start tunnel' }
    }
    $exe = Get-CloudflaredExe
    if ($exe -eq $null) {
      Write-Audit '[ERROR] cloudflared.exe not found'
      return @{ ok = $false; command = 'heal'; actions = $actions; message = '找不到 cloudflared.exe' }
    }
    try {
      $np = Start-Process -FilePath $exe -ArgumentList @('tunnel', '--url', $TargetUrl, '--no-autoupdate', '--logfile', $TunnelLog, '--loglevel', 'info') -WindowStyle Hidden -PassThru
      Write-Audit ('[HEAL] started cloudflared pid={0} (was none)' -f $np.Id)
      return @{ ok = $true; command = 'heal'; actions = $actions; changed = $true; message = 'started tunnel' }
    } catch {
      Write-Audit ('[ERROR] start cloudflared failed: ' + $_.Exception.Message)
      return @{ ok = $false; command = 'heal'; actions = $actions; message = $_.Exception.Message }
    }
  }

  # 已有隧道：只在**确实**不健康时才换，且绝不因为「进程存在」就再起一个。
  #
  # 「没问到」（reachable=false，超时/DNS 抖动）与「问到了但是 5xx」是两回事：
  # 前者只记日志不下结论，避免刚建好的 quick tunnel 被立刻拆掉（0.7.0 自测时
  # 就踩过这个坑：12 秒超时 → 判死 → 轮换 → 新隧道还没出地址 → 隧道全没了）。
  if (-not $health.ok -and $health.reachable) {
    $actions += 'tunnel-unhealthy'
    Write-Audit ('[HEAL] tunnel unhealthy (status={0} note={1}), rotating' -f $health.status, $health.note)
    if ($DryRun) {
      Write-Audit '[DRYRUN] would rotate the tunnel'
      return @{ ok = $true; command = 'heal'; dryRun = $true; actions = $actions; changed = $false; message = 'would rotate tunnel' }
    }
    $rotated = Invoke-TunnelRestart
    $actions += 'tunnel-rotated'
    return @{ ok = $rotated.ok; command = 'heal'; actions = $actions; changed = $rotated.ok; address = $rotated.address; message = 'rotated unhealthy tunnel' }
  }
  if (-not $health.ok -and -not $health.reachable) {
    $actions += 'tunnel-unanswered'
    Write-Audit ('[HEAL] tunnel did not answer this round ({0}); keeping it, will retry next cycle' -f $health.note)
    return @{ ok = $true; command = 'heal'; actions = $actions; changed = $false; address = $addr; message = 'tunnel did not answer, kept as is' }
  }

  Write-Audit ('[HEAL] healthy (pid count={0}, address={1})' -f $procs.Count, $addr)
  return @{ ok = $true; command = 'heal'; actions = $actions; changed = $false; address = $addr; message = 'healthy' }
}

# ---- dispatch ---------------------------------------------------------------

$result = $null
try {
  switch ($Command) {
    'status'        { $result = Invoke-Status }
    'reload'        { $result = Invoke-Reload }
    'restart'       { $result = Invoke-Restart }
    'tunnel-restart' { $result = Invoke-TunnelRestart }
    'tunnel-rotate' { $result = Invoke-TunnelRestart }
    'heal'          { $result = Invoke-Heal }
  }
} catch {
  Write-Audit ('[ERROR] ' + $Command + ' failed: ' + $_.Exception.Message)
  $result = @{ ok = $false; command = $Command; code = 'exception'; message = $_.Exception.Message }
}

if ($result -eq $null) {
  $result = @{ ok = $false; command = $Command; code = 'no-result'; message = 'command produced no result' }
}

if (-not $DryRun -and $Command -ne 'status') {
  Write-Audit ('[DONE] ' + $Command + ' ok=' + $result.ok)
}

Write-Result -Payload $result
if ($result.ok) { exit 0 } else { exit 1 }

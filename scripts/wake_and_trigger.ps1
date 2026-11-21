param(
  [string]$SlotTime = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$DataDir = Join-Path $PluginRoot 'data'
$SchedulePath = Join-Path $DataDir 'schedule.json'
$StatePath = Join-Path $DataDir 'state.json'
$HistoryPath = Join-Path $DataDir 'history.json'
$RuntimePath = Join-Path $DataDir 'runtime.json'
$PendingPath = Join-Path $DataDir 'pending_trigger.json'
$LockPath = Join-Path $DataDir 'trigger.lock'
$LogPath = Join-Path $DataDir 'wake.log'

if (!(Test-Path $DataDir)) {
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

function Write-WakeLog {
  param([string]$Message)
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff zzz')
  $line = "[$ts] $Message"
  $enc = New-Object System.Text.UTF8Encoding($false)
  try {
    if (Test-Path $LogPath) {
      $lines = [System.IO.File]::ReadAllLines($LogPath, [System.Text.Encoding]::UTF8)
      if ($lines.Length -gt 300) {
        $tail = $lines[($lines.Length - 200)..($lines.Length - 1)]
        [System.IO.File]::WriteAllLines($LogPath, $tail, $enc)
      }
    }
    [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $enc)
  } catch {
    # Ignore log write errors
  }
}

function Read-Utf8Json {
  param([string]$Path, $Fallback)
  if (!(Test-Path $Path)) { return $Fallback }
  try {
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    $raw = $raw.TrimStart([char]0xFEFF).Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Fallback }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $Fallback
  }
}

function Write-Utf8JsonAtomic {
  param([string]$Path, $Obj)
  $json = $Obj | ConvertTo-Json -Depth 12
  $tmp = "$Path.tmp.$PID.$([guid]::NewGuid().ToString('N'))"
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmp, $json, $enc)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Resolve-AntigravityExe {
  param($Runtime)
  $candidates = New-Object System.Collections.Generic.List[string]

  if ($Runtime -and $Runtime.PSObject.Properties['antigravityExe'] -and $Runtime.antigravityExe) {
    $exe = [string]$Runtime.antigravityExe
    if ($exe -match 'Antigravity\.exe$') {
      [void]$candidates.Add($exe)
    }
  }

  [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'))
  if ($env:ProgramFiles) {
    [void]$candidates.Add((Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe'))
  }
  if (${env:ProgramFiles(x86)}) {
    [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Antigravity\Antigravity.exe'))
  }

  $regRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($root in $regRoots) {
    $entries = Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Antigravity*' }
    foreach ($e in $entries) {
      if ($e.InstallLocation) {
        [void]$candidates.Add((Join-Path $e.InstallLocation 'Antigravity.exe'))
      }
      if ($e.DisplayIcon) {
        $icon = ([string]$e.DisplayIcon).Split(',')[0].Trim().Trim('"')
        if ($icon -match '\.exe$') {
          [void]$candidates.Add($icon)
        }
      }
    }
  }

  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  if (Test-Path $startMenu) {
    $lnks = Get-ChildItem -Path $startMenu -Filter '*Antigravity*.lnk' -Recurse -ErrorAction SilentlyContinue
    if ($lnks) {
      $ws = New-Object -ComObject WScript.Shell
      foreach ($lnk in $lnks) {
        try {
          $target = $ws.CreateShortcut($lnk.FullName).TargetPath
          if ($target) { [void]$candidates.Add($target) }
        } catch {}
      }
    }
  }

  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

function Find-ActiveDaemonHub {
  $daemonDir = Join-Path $env:USERPROFILE '.gemini\antigravity\daemon'
  if (!(Test-Path $daemonDir)) { return $null }
  $files = Get-ChildItem -Path $daemonDir -Filter 'hub_*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  foreach ($f in $files) {
    $hub = Read-Utf8Json -Path $f.FullName -Fallback $null
    if ($null -eq $hub -or -not $hub.pid -or -not $hub.httpPort) { continue }
    $proc = Get-Process -Id ([int]$hub.pid) -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$($hub.httpPort)/healthz" -UseBasicParsing -TimeoutSec 3
      if ($resp.StatusCode -eq 200) {
        return $hub
      }
    } catch {}
  }
  return $null
}

function Format-WinArg {
  param([string]$Arg)
  if ($null -eq $Arg) { return '""' }
  if ($Arg.Length -eq 0) { return '""' }
  if ($Arg -notmatch '[\s"]') { return $Arg }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $bsCount = 0
  for ($i = 0; $i -lt $Arg.Length; $i++) {
    $ch = $Arg[$i]
    if ($ch -eq '\') {
      $bsCount++
    } elseif ($ch -eq '"') {
      [void]$sb.Append('\', $bsCount * 2 + 1)
      [void]$sb.Append('"')
      $bsCount = 0
    } else {
      if ($bsCount -gt 0) {
        [void]$sb.Append('\', $bsCount)
        $bsCount = 0
      }
      [void]$sb.Append($ch)
    }
  }
  if ($bsCount -gt 0) {
    [void]$sb.Append('\', $bsCount * 2)
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Acquire-FileLock {
  param([int]$TimeoutSec = 120)
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      $fs = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("$PID|$((Get-Date).ToString('o'))")
      $fs.Write($bytes, 0, $bytes.Length)
      $fs.Close()
      return $true
    } catch {
      if (Test-Path $LockPath) {
        try {
          $age = ((Get-Date) - (Get-Item $LockPath).LastWriteTime).TotalSeconds
          if ($age -gt $TimeoutSec) {
            Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
            continue
          }
        } catch {}
      }
      Start-Sleep -Milliseconds 300
    }
  }
  return $false
}

function Release-FileLock {
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

function Extract-ConversationId {
  param($Obj)
  if ($null -eq $Obj) { return '' }
  if ($Obj -is [string]) { return '' }
  foreach ($propName in @('conversationId', 'conversation_id', 'id')) {
    if ($Obj.PSObject -and $Obj.PSObject.Properties[$propName]) {
      $val = [string]$Obj.$propName
      if (-not [string]::IsNullOrWhiteSpace($val)) { return $val }
    }
  }
  if ($Obj.PSObject) {
    foreach ($p in $Obj.PSObject.Properties) {
      if ($p.Value -and ($p.Value -is [PSCustomObject] -or $p.Value -is [System.Collections.IDictionary])) {
        $found = Extract-ConversationId -Obj $p.Value
        if ($found) { return $found }
      }
    }
  }
  return ''
}

function Record-Execution {
  param(
    [string]$SlotKey,
    [string]$Status,
    [string]$Source,
    [string]$ConversationId,
    [string]$Message,
    [string]$Model,
    [string]$ErrorMsg
  )
  $nowIso = (Get-Date).ToString('o')
  $state = Read-Utf8Json -Path $StatePath -Fallback ([PSCustomObject]@{})
  if ($null -eq $state) { $state = [PSCustomObject]@{} }

  $firedMap = [ordered]@{}
  if ($state.PSObject.Properties['firedSlots'] -and $state.firedSlots) {
    $cutoff = (Get-Date).AddDays(-60)
    foreach ($prop in $state.firedSlots.PSObject.Properties) {
      $keep = $true
      if ($prop.Name -match '^(\d{4}-\d{2}-\d{2})_') {
        try {
          $d = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd', $null)
          if ($d -lt $cutoff) { $keep = $false }
        } catch {}
      }
      if ($keep) { $firedMap[$prop.Name] = $prop.Value }
    }
  }
  $entry = [ordered]@{
    status = $Status
    at = $nowIso
    source = $Source
    conversationId = $ConversationId
    error = $ErrorMsg
  }
  $firedMap[$SlotKey] = $entry

  $newState = [ordered]@{
    lastSyncAt = if ($state.PSObject.Properties['lastSyncAt']) { $state.lastSyncAt } else { '' }
    syncedTasks = if ($state.PSObject.Properties['syncedTasks'] -and $state.syncedTasks) { @($state.syncedTasks) } else { @() }
    syncError = if ($state.PSObject.Properties['syncError']) { $state.syncError } else { '' }
    lastRun = [ordered]@{
      slotKey = $SlotKey
      status = $Status
      at = $nowIso
      source = $Source
      conversationId = $ConversationId
      error = $ErrorMsg
    }
    firedSlots = $firedMap
  }
  Write-Utf8JsonAtomic -Path $StatePath -Obj $newState

  $histRaw = Read-Utf8Json -Path $HistoryPath -Fallback @()
  $histList = New-Object System.Collections.Generic.List[object]
  [void]$histList.Add([ordered]@{
    slotKey = $SlotKey
    at = $nowIso
    status = $Status
    source = $Source
    conversationId = $ConversationId
    message = $Message
    model = $Model
    error = $ErrorMsg
  })
  foreach ($item in @($histRaw)) {
    if ($histList.Count -ge 50) { break }
    if ($null -ne $item) { [void]$histList.Add($item) }
  }
  Write-Utf8JsonAtomic -Path $HistoryPath -Obj (@($histList.ToArray()))
}

# --- Main flow ---
$defaultMsg = ([char]0x4F60 + [char]0x597D)
$defaultTitle = ([char]0x989D + [char]0x5EA6 + [char]0x9884 + [char]0x70ED)

$now = Get-Date
$normalizedTime = $SlotTime.Trim()
if ($normalizedTime -match '^([01]\d|2[0-3]):[0-5]\d$') {
  $slotKey = "$($now.ToString('yyyy-MM-dd'))_$normalizedTime"
} else {
  $slotKey = $now.ToString('yyyy-MM-dd_HH:mm')
}

Write-WakeLog "Triggered wake_and_trigger.ps1 for slotKey=$slotKey"

$schedule = Read-Utf8Json -Path $SchedulePath -Fallback $null
if ($null -eq $schedule -or -not [bool]$schedule.enabled) {
  Write-WakeLog "Schedule is missing or globally disabled; exiting."
  exit 0
}

$state = Read-Utf8Json -Path $StatePath -Fallback $null
if ($state -and $state.PSObject.Properties['firedSlots'] -and $state.firedSlots) {
  if ($state.firedSlots.PSObject.Properties[$slotKey]) {
    $slotInfo = $state.firedSlots.$slotKey
    if ($slotInfo -and $slotInfo.status -eq 'ok') {
      Write-WakeLog "Slot $slotKey already succeeded earlier; skipping."
      exit 0
    }
  }
}

$msgText = if ($schedule.message -and -not [string]::IsNullOrWhiteSpace([string]$schedule.message)) { [string]$schedule.message } else { $defaultMsg }
$titleText = if ($schedule.title -and -not [string]::IsNullOrWhiteSpace([string]$schedule.title)) { [string]$schedule.title } else { $defaultTitle }
$modelText = if ($schedule.model) { ([string]$schedule.model).Trim() } else { '' }

$pendingObj = [ordered]@{
  triggerId = [guid]::NewGuid().ToString()
  slotKey = $slotKey
  createdAt = (Get-Date).ToString('o')
  message = $msgText
  model = $modelText
  title = $titleText
  source = 'task_scheduler'
}
Write-Utf8JsonAtomic -Path $PendingPath -Obj $pendingObj
Write-WakeLog "Wrote pending_trigger.json (triggerId=$($pendingObj.triggerId))"

$runtime = Read-Utf8Json -Path $RuntimePath -Fallback $null
$runningApp = Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue
if (-not $runningApp) {
  $exePath = Resolve-AntigravityExe -Runtime $runtime
  if (-not $exePath) {
    Write-WakeLog "ERROR: Antigravity.exe could not be located."
    Record-Execution -SlotKey $slotKey -Status 'error' -Source 'task_scheduler_fallback' -ConversationId '' -Message $msgText -Model $modelText -ErrorMsg 'Antigravity.exe not found'
    exit 1
  }
  Write-WakeLog "Antigravity is not running; launching $exePath"
  Start-Process -FilePath $exePath | Out-Null
} else {
  Write-WakeLog "Antigravity is already running (count=$((@($runningApp)).Count))"
}

# Wait up to 60 seconds for Sidecar scheduler to consume pending_trigger.json
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  $curState = Read-Utf8Json -Path $StatePath -Fallback $null
  if ($curState -and $curState.PSObject.Properties['firedSlots'] -and $curState.firedSlots) {
    if ($curState.firedSlots.PSObject.Properties[$slotKey]) {
      $s = $curState.firedSlots.$slotKey
      if ($s -and $s.status -eq 'ok') {
        Write-WakeLog "Slot $slotKey consumed by Sidecar (conversationId=$($s.conversationId))."
        exit 0
      }
    }
  }
}

Write-WakeLog "Sidecar did not mark slot $slotKey within 60s; entering fallback daemon trigger."

if (!(Acquire-FileLock)) {
  Write-WakeLog "Could not acquire trigger.lock; another worker is handling it."
  exit 0
}

try {
  $curState = Read-Utf8Json -Path $StatePath -Fallback $null
  if ($curState -and $curState.PSObject.Properties['firedSlots'] -and $curState.firedSlots) {
    if ($curState.firedSlots.PSObject.Properties[$slotKey]) {
      $s = $curState.firedSlots.$slotKey
      if ($s -and $s.status -eq 'ok') {
        Write-WakeLog "Slot $slotKey completed just before lock; exiting."
        exit 0
      }
    }
  }

  $hub = $null
  for ($h = 0; $h -lt 10; $h++) {
    $hub = Find-ActiveDaemonHub
    if ($hub) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $hub) {
    throw 'No healthy Antigravity daemon hub found.'
  }

  $runtime = Read-Utf8Json -Path $RuntimePath -Fallback $null
  $agentExe = $null
  $isDirectLs = $false

  if ($runtime -and $runtime.PSObject.Properties['agentapiExe'] -and $runtime.agentapiExe -and (Test-Path ([string]$runtime.agentapiExe))) {
    $agentExe = [string]$runtime.agentapiExe
    $isDirectLs = $true
  } else {
    $exePath = Resolve-AntigravityExe -Runtime $runtime
    if ($exePath) {
      $lsCandidate = Join-Path (Split-Path -Parent $exePath) 'resources\bin\language_server.exe'
      if (Test-Path $lsCandidate) {
        $agentExe = $lsCandidate
        $isDirectLs = $true
      }
    }
  }
  if (-not $agentExe) {
    $batCandidate = Join-Path $env:USERPROFILE '.gemini\antigravity\bin\agentapi.bat'
    if (Test-Path $batCandidate) {
      $agentExe = $batCandidate
      $isDirectLs = $false
    }
  }
  if (-not $agentExe) {
    throw 'Could not locate language_server.exe or agentapi.bat.'
  }

  $cliArgs = New-Object System.Collections.Generic.List[string]
  if ($isDirectLs) { [void]$cliArgs.Add('agentapi') }
  [void]$cliArgs.Add('new-conversation')
  [void]$cliArgs.Add('--title')
  [void]$cliArgs.Add($titleText)
  if (-not [string]::IsNullOrWhiteSpace($modelText)) {
    [void]$cliArgs.Add('--model')
    [void]$cliArgs.Add($modelText)
  }
  [void]$cliArgs.Add('--')
  [void]$cliArgs.Add($msgText)

  $argString = ($cliArgs | ForEach-Object { Format-WinArg $_ }) -join ' '

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  if ($isDirectLs) {
    $psi.FileName = $agentExe
    $psi.Arguments = $argString
  } else {
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = "/c `"$agentExe`" $argString"
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  $projectId = 'outside-of-project'
  if ($runtime -and $runtime.PSObject.Properties['projectId'] -and -not [string]::IsNullOrWhiteSpace([string]$runtime.projectId)) {
    $projectId = [string]$runtime.projectId
  }
  $psi.EnvironmentVariables['ANTIGRAVITY_LS_ADDRESS'] = "localhost:$($hub.httpPort)"
  $psi.EnvironmentVariables['ANTIGRAVITY_CSRF_TOKEN'] = [string]$hub.csrfToken
  $psi.EnvironmentVariables['ANTIGRAVITY_PROJECT_ID'] = $projectId

  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()

  if ($proc.ExitCode -ne 0) {
    throw "agentapi exited with code $($proc.ExitCode): $stderr $stdout"
  }

  $convId = ''
  if (-not [string]::IsNullOrWhiteSpace($stdout)) {
    try {
      $parsed = $stdout.Trim() | ConvertFrom-Json
      $convId = Extract-ConversationId -Obj $parsed
    } catch {}
  }

  Record-Execution -SlotKey $slotKey -Status 'ok' -Source 'task_scheduler_fallback' -ConversationId $convId -Message $msgText -Model $modelText -ErrorMsg ''
  if (Test-Path $PendingPath) {
    $p = Read-Utf8Json -Path $PendingPath -Fallback $null
    if ($p -and $p.slotKey -eq $slotKey) {
      Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
    }
  }
  Write-WakeLog "Fallback trigger succeeded for slot $slotKey (conversationId=$convId)."
} catch {
  $errMsg = $_.Exception.Message
  Write-WakeLog "ERROR in fallback trigger: $errMsg"
  Record-Execution -SlotKey $slotKey -Status 'error' -Source 'task_scheduler_fallback' -ConversationId '' -Message $msgText -Model $modelText -ErrorMsg $errMsg
  exit 1
} finally {
  Release-FileLock
}
exit 0

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$DataDir = Join-Path $PluginRoot 'data'
$SchedulePath = Join-Path $DataDir 'schedule.json'
$StatePath = Join-Path $DataDir 'state.json'
$VbsPath = Join-Path $ScriptDir 'run_hidden.vbs'
$TaskPrefix = 'AntigravityQuotaWarmup_'

if (!(Test-Path $DataDir)) {
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
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
  $json = $Obj | ConvertTo-Json -Depth 10
  $tmp = "$Path.tmp.$PID.$([guid]::NewGuid().ToString('N'))"
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmp, $json, $enc)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

$dayMap = [ordered]@{
  mon = @{ PsDay = 'Monday';    SchDay = 'MON' }
  tue = @{ PsDay = 'Tuesday';   SchDay = 'TUE' }
  wed = @{ PsDay = 'Wednesday'; SchDay = 'WED' }
  thu = @{ PsDay = 'Thursday';  SchDay = 'THU' }
  fri = @{ PsDay = 'Friday';    SchDay = 'FRI' }
  sat = @{ PsDay = 'Saturday';  SchDay = 'SAT' }
  sun = @{ PsDay = 'Sunday';    SchDay = 'SUN' }
}

$schedule = Read-Utf8Json -Path $SchedulePath -Fallback $null
if ($null -eq $schedule) {
  $errObj = [ordered]@{
    ok = $false
    error = "Missing or invalid schedule.json at $SchedulePath"
    syncedTasks = @()
    lastSyncAt = (Get-Date).ToString('o')
  }
  [Console]::WriteLine(($errObj | ConvertTo-Json -Compress -Depth 6))
  exit 1
}

$syncedList = New-Object System.Collections.Generic.List[string]
$syncError = ''

try {
  # Remove all existing AntigravityQuotaWarmup_ tasks under root path
  $existing = Get-ScheduledTask -TaskName "${TaskPrefix}*" -ErrorAction SilentlyContinue
  if ($existing) {
    foreach ($t in $existing) {
      try {
        Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction Stop
      } catch {
        & schtasks.exe /Delete /TN "$($t.TaskName)" /F 2>$null | Out-Null
      }
    }
  }

  # Also check via schtasks CSV in case any orphaned root task was missed
  $csvOut = & schtasks.exe /Query /FO CSV /NH 2>$null
  if ($LASTEXITCODE -eq 0 -and $csvOut) {
    foreach ($line in $csvOut) {
      if ($line -match ',"\\([^"\\]+)"') {
        $tn = $Matches[1]
        if ($tn.StartsWith($TaskPrefix)) {
          & schtasks.exe /Delete /TN "$tn" /F 2>$null | Out-Null
        }
      }
    }
  }

  $globalEnabled = [bool]$schedule.enabled
  $runIfMissed = [bool]$schedule.runIfMissed

  if ($globalEnabled -and $schedule.days) {
    foreach ($dayKey in $dayMap.Keys) {
      $dayCfg = $schedule.days.$dayKey
      if ($null -eq $dayCfg -or -not [bool]$dayCfg.enabled) { continue }

      $seenTimes = New-Object System.Collections.Generic.HashSet[string]
      $rawTimes = @($dayCfg.times)
      foreach ($rawTime in $rawTimes) {
        if ($null -eq $rawTime) { continue }
        $t = ([string]$rawTime).Trim()
        if ($t -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { continue }
        if (-not $seenTimes.Add($t)) { continue }

        $schDay = $dayMap[$dayKey].SchDay
        $psDay = $dayMap[$dayKey].PsDay
        $hhmm = $t.Replace(':', '')
        $taskName = "${TaskPrefix}${schDay}_${hhmm}"
        $vbsArgs = "`"$VbsPath`" `"$t`""

        $registered = $false
        try {
          $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $vbsArgs
          $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $psDay -At $t
          $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
            -StartWhenAvailable:$runIfMissed
          Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
          $registered = $true
        } catch {
          $trCmd = "wscript.exe \`"$VbsPath\`" \`"$t\`""
          $out = & schtasks.exe /Create /TN $taskName /SC WEEKLY /D $schDay /ST $t /TR $trCmd /F 2>&1
          if ($LASTEXITCODE -eq 0) {
            $registered = $true
          } else {
            throw "Failed to register task ${taskName}: $out"
          }
        }

        if ($registered) {
          [void]$syncedList.Add($taskName)
        }
      }
    }
  }
} catch {
  $syncError = $_.Exception.Message
}

$nowIso = (Get-Date).ToString('o')
$state = Read-Utf8Json -Path $StatePath -Fallback ([PSCustomObject]@{})
if ($null -eq $state) { $state = [PSCustomObject]@{} }

$firedSlots = if ($state.PSObject.Properties['firedSlots'] -and $state.firedSlots) {
  $state.firedSlots
} else {
  [PSCustomObject]@{}
}

$newState = [ordered]@{
  lastSyncAt = $nowIso
  syncedTasks = @($syncedList.ToArray())
  syncError = $syncError
  firedSlots = $firedSlots
}
if ($state.PSObject.Properties['lastRun']) {
  $newState.lastRun = $state.lastRun
}

Write-Utf8JsonAtomic -Path $StatePath -Obj $newState

$result = [ordered]@{
  ok = [string]::IsNullOrEmpty($syncError)
  syncedTasks = @($syncedList.ToArray())
  lastSyncAt = $nowIso
  error = $syncError
}
[Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
if (-not [string]::IsNullOrEmpty($syncError)) {
  exit 1
}
exit 0

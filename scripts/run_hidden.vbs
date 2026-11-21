Option Explicit

Dim fso, shell, scriptDir, pluginRoot, wakeScript, slotTime, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
pluginRoot = fso.GetParentFolderName(scriptDir)
wakeScript = fso.BuildPath(scriptDir, "wake_and_trigger.ps1")

slotTime = ""
If WScript.Arguments.Count > 0 Then
  slotTime = Trim(WScript.Arguments(0))
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & wakeScript & """"
If Len(slotTime) > 0 Then
  cmd = cmd & " -SlotTime """ & slotTime & """"
End If

shell.Run cmd, 0, False

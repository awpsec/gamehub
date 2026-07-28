' Silent wrapper so Task Scheduler never flashes a blue PowerShell console.
' Gamehub regenerates this file next to elevatedGameLauncher.ps1.
Option Explicit
Dim sh, ps1, bridge, cmd, dot
If WScript.Arguments.Count < 1 Then
  WScript.Quit 1
End If
bridge = WScript.Arguments(0)
dot = InStrRev(WScript.ScriptFullName, ".")
If dot < 1 Then WScript.Quit 1
ps1 = Left(WScript.ScriptFullName, dot) & "ps1"
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """ -BridgeDir """ & bridge & """"
' 0 = hidden window, True = wait for exit
sh.Run cmd, 0, True

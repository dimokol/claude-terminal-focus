' bin/hide.vbs — silent launcher for the claude-notif:// URL handler.
'
' Why this exists: when the user clicks the OS toast, Windows shell
' invokes the registered command — which previously was a direct
' "node.exe launcher.js %1" call. Because node.exe is a console
' subsystem binary, Windows allocates a console window every time it
' starts, even for fire-and-forget scripts that exit in <100ms. That
' window flashes briefly on every banner click, visible and annoying.
'
' VBScript run through wscript.exe is a windowless host. CreateObject
' WScript.Shell + Run with intWindowStyle=0 launches the target
' executable hidden and returns immediately (bWaitOnReturn=False).
'
' Args: <exePath> [arg1] [arg2] ...
' Usage from registry: wscript.exe "C:\...\hide.vbs" "node.exe" "launcher.js" "%1"

Option Explicit
Dim objShell, cmd, i

If WScript.Arguments.Count < 1 Then WScript.Quit(0)

Set objShell = CreateObject("WScript.Shell")
cmd = """" & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next

' Run hidden (0), don't wait (False).
objShell.Run cmd, 0, False

' 🦊 Foxy Network — Lanzador Silencioso en Segundo Plano
' Ejecuta el nodo donante de Foxy Network sin abrir ninguna ventana de consola.

Set WshShell = CreateObject("WScript.Shell")
currentDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

WshShell.CurrentDirectory = currentDir
WshShell.Run "node scripts/start-all.js", 0, False

Set WshShell = Nothing

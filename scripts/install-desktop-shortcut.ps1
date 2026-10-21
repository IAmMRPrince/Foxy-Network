# 🦊 Foxy Network — Creador de Acceso Directo en el Escritorio de Windows
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath "Foxy Network.lnk"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path "$ScriptDir\..").Path
$TargetPath = Join-Path $RootDir "Foxy-Tray.bat"

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.WorkingDirectory = $RootDir
$Shortcut.Description = "Iniciar Nodo Donante de Foxy Network en segundo plano"
$Shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,14" # Globe/Network icon
$Shortcut.Save()

Write-Host "✅ Acceso directo creado exitosamente en tu Escritorio:" -ForegroundColor Green
Write-Host "   $ShortcutPath" -ForegroundColor Cyan

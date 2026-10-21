# 🦊 Foxy Network — Agente de Bandeja del Sistema (Windows System Tray)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path "$ScriptDir\..\..\..").Path
Set-Location $RootDir

# Start background ecosystem process if not already running
$ExistingNode = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*start-all.js*" }
$DaemonProcess = $null

if (-not $ExistingNode) {
    $DaemonProcess = Start-Process -FilePath "node" -ArgumentList "scripts/start-all.js" -WorkingDirectory $RootDir -WindowStyle Hidden -PassThru
}

# Create System Tray NotifyIcon
$NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$NotifyIcon.Text = "🦊 Foxy Network — Nodo Donante Activo"

# Extract default application icon
$NotifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$NotifyIcon.Visible = $true

# Context Menu
$ContextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# 1. Abrir Dashboard
$MenuItemDashboard = New-Object System.Windows.Forms.ToolStripMenuItem
$MenuItemDashboard.Text = "🦊 Abrir Panel del Donante (Dashboard)"
$MenuItemDashboard.Font = New-Object System.Drawing.Font($MenuItemDashboard.Font, [System.Drawing.FontStyle]::Bold)
$MenuItemDashboard.Add_Click({
    Start-Process "http://localhost:4040"
})
$ContextMenu.Items.Add($MenuItemDashboard) | Out-Null

# 2. Ver Saldo de Tokens
$MenuItemBalance = New-Object System.Windows.Forms.ToolStripMenuItem
$MenuItemBalance.Text = "🪙 Consultar Saldo $FOXY"
$MenuItemBalance.Add_Click({
    try {
        $state = Invoke-RestMethod -Uri "http://localhost:4040/api/state" -TimeoutSec 3
        $bal = if ($state.rewards.balance) { $state.rewards.balance } else { 0 }
        $tier = if ($state.rewards.tier) { $state.rewards.tier } else { "STANDARD" }
        $life = if ($state.rewards.lifetimeEarnings) { $state.rewards.lifetimeEarnings } else { 0 }
        $NotifyIcon.ShowBalloonTip(3000, "🪙 Foxy Network Tokenomics", "Saldo: $bal `$FOXY`nTier: $tier`nTotal histórico: $life `$FOXY", [System.Windows.Forms.ToolTipIcon]::Info)
    } catch {
        $NotifyIcon.ShowBalloonTip(3000, "Foxy Network", "Conectando con el daemon local...", [System.Windows.Forms.ToolTipIcon]::Warning)
    }
})
$ContextMenu.Items.Add($MenuItemBalance) | Out-Null

# Separator
$ContextMenu.Items.Add("-") | Out-Null

# 3. Abrir Gateway
$MenuItemGateway = New-Object System.Windows.Forms.ToolStripMenuItem
$MenuItemGateway.Text = "🌐 Ver Ingress Gateway (Portal de Servidores)"
$MenuItemGateway.Add_Click({
    Start-Process "http://localhost:8080"
})
$ContextMenu.Items.Add($MenuItemGateway) | Out-Null

# 4. Pausar / Reanudar Donación
$MenuItemToggle = New-Object System.Windows.Forms.ToolStripMenuItem
$MenuItemToggle.Text = "⏸️ Pausar / Reanudar Donación"
$MenuItemToggle.Add_Click({
    try {
        $res = Invoke-RestMethod -Uri "http://localhost:4040/api/toggle-donation" -Method Post -TimeoutSec 3
        if ($res.isDonating) {
            $NotifyIcon.ShowBalloonTip(2000, "Foxy Network", "Donación de recursos ACTIVADA", [System.Windows.Forms.ToolTipIcon]::Info)
        } else {
            $NotifyIcon.ShowBalloonTip(2000, "Foxy Network", "Donación de recursos PAUSADA", [System.Windows.Forms.ToolTipIcon]::Warning)
        }
    } catch {
        # Ignore
    }
})
$ContextMenu.Items.Add($MenuItemToggle) | Out-Null

# Separator
$ContextMenu.Items.Add("-") | Out-Null

# 5. Salir
$MenuItemExit = New-Object System.Windows.Forms.ToolStripMenuItem
$MenuItemExit.Text = "❌ Salir de Foxy Network"
$MenuItemExit.Add_Click({
    $NotifyIcon.Visible = $false
    if ($DaemonProcess) {
        Stop-Process -Id $DaemonProcess.Id -Force -ErrorAction SilentlyContinue
    }
    # Also stop node processes started by script
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*start-all.js*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    [System.Windows.Forms.Application]::Exit()
})
$ContextMenu.Items.Add($MenuItemExit) | Out-Null

$NotifyIcon.ContextMenuStrip = $ContextMenu

# Double click action: open dashboard
$NotifyIcon.Add_DoubleClick({
    Start-Process "http://localhost:4040"
})

# Startup Notification Balloon
$NotifyIcon.ShowBalloonTip(3000, "🦊 Foxy Network Activo", "El nodo donante se está ejecutando en segundo plano.`nHaz doble clic para abrir el panel de control.", [System.Windows.Forms.ToolTipIcon]::Info)

# Run Windows message loop
[System.Windows.Forms.Application]::Run()

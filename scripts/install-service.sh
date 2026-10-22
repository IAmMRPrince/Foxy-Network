#!/usr/bin/env bash
# ==============================================================================
# Foxy Network - Background Service Installer (Systemd for Linux / Launchd for macOS)
# Configures Foxy Daemon to run automatically on system boot.
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." >/dev/null 2>&1 && pwd )"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
    echo "Error: Node.js no encontrado en el PATH."
    exit 1
fi

OS="$(uname -s)"

if [ "$OS" = "Linux" ]; then
    echo "Configurando Foxy Daemon como servicio de usuario Systemd (Linux)..."
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"
    
    SERVICE_FILE="$SYSTEMD_DIR/foxy-daemon.service"
    cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=Foxy Network Donor Daemon & dVPN Node
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE_BIN packages/foxy-daemon/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=FOXY_DAEMON_PORT=4040

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable foxy-daemon.service
    systemctl --user start foxy-daemon.service
    echo "✅ Servicio instalado e iniciado!"
    echo "   Ver estado: systemctl --user status foxy-daemon"
    echo "   Ver logs:   journalctl --user -u foxy-daemon -f"

elif [ "$OS" = "Darwin" ]; then
    echo "Configurando Foxy Daemon como agente Launchd (macOS)..."
    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$LAUNCHD_DIR"
    
    PLIST_FILE="$LAUNCHD_DIR/com.foxy.network.daemon.plist"
    cat <<EOF > "$PLIST_FILE"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.foxy.network.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DIR/packages/foxy-daemon/src/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$DIR/foxy-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$DIR/foxy-daemon-err.log</string>
</dict>
</plist>
EOF

    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    launchctl load "$PLIST_FILE"
    echo "✅ Agente Launchd instalado e iniciado!"
    echo "   Logs en: $DIR/foxy-daemon.log"
else
    echo "Sistema operativo no reconocido: $OS"
    exit 1
fi

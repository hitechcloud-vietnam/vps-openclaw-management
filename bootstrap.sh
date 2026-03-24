#!/bin/bash
# =============================================================================
# OpenClaw Bootstrap — Wait for cloud-init, reboot, then run install.sh
#
# Usage (run from SSH):
#   curl -fsSL <url>/bootstrap.sh | bash -s -- --mgmt-key <KEY> [--domain <DOMAIN>]
#
# Flow:
#   1. Wait for cloud-init to finish
#   2. Download install.sh to /opt/openclaw/
#   3. Create a systemd one-shot service to run install.sh after reboot
#   4. Reboot VPS
#   5. After reboot, systemd runs install.sh, then disables the service automatically
#
# Check progress: tail -f /var/log/openclaw-install.log
# =============================================================================

REPO_RAW="https://raw.githubusercontent.com/Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management/main"
BOOTSTRAP_DIR="/opt/openclaw"
INSTALL_SCRIPT="${BOOTSTRAP_DIR}/openclaw-install.sh"
INSTALL_ARGS="${BOOTSTRAP_DIR}/openclaw-install.args"
LOG_FILE="/var/log/openclaw-install.log"
SERVICE_NAME="openclaw-install"

# Create directory first
mkdir -p "$BOOTSTRAP_DIR"

# Save arguments to file for systemd to read after reboot
echo "$*" > "$INSTALL_ARGS"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bootstrap: $*" | tee -a "$LOG_FILE"; }

log "Starting bootstrap..."

# =============================================================================
# 1. Wait for cloud-init to finish
# =============================================================================
log "Waiting for cloud-init to finish..."
if command -v cloud-init &>/dev/null; then
    cloud-init status --wait 2>&1 | while IFS= read -r line; do
        log "cloud-init: $line"
    done
    log "cloud-init is done."
else
    log "cloud-init not found, skipping."
fi

# =============================================================================
# 2. Download install.sh
# =============================================================================
log "Downloading install.sh..."
if ! curl -fsSL "${REPO_RAW}/install.sh" -o "$INSTALL_SCRIPT"; then
    log "ERROR - Failed to download install.sh"
    exit 1
fi
chmod +x "$INSTALL_SCRIPT"
log "Successfully downloaded install.sh."

# =============================================================================
# 3. Create systemd one-shot service to run install.sh after reboot
# =============================================================================
log "Saved arguments: $(cat "$INSTALL_ARGS")"
log "Creating systemd service ${SERVICE_NAME} to run after reboot..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SERVICEEOF'
[Unit]
Description=OpenClaw Post-Reboot Installer
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/openclaw/openclaw-install.sh

[Service]
Type=oneshot
Environment=DEBIAN_FRONTEND=noninteractive
ExecStart=/bin/bash -c '/opt/openclaw/openclaw-install.sh $(cat /opt/openclaw/openclaw-install.args) >> /var/log/openclaw-install.log 2>&1; systemctl disable openclaw-install.service; rm -f /etc/systemd/system/openclaw-install.service /opt/openclaw/openclaw-install.sh /opt/openclaw/openclaw-install.args; systemctl daemon-reload'
RemainAfterExit=false
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}.service
log "Service ${SERVICE_NAME} has been enabled."

# =============================================================================
# 4. Reboot
# =============================================================================
log "Rebooting VPS in 5 seconds..."
log "After reboot, install will run automatically. Track progress with: tail -f ${LOG_FILE}"

# Use nohup + sleep so SSH returns before rebooting
nohup bash -c "sleep 5 && reboot" &>/dev/null &

log "Bootstrap complete. VPS will reboot now."
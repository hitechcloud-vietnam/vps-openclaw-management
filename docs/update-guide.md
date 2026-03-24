# OpenClaw Upgrade Guide

## Table of Contents

- [1. Upgrade via Management API (Recommended)](#1-upgrade-via-management-api-recommended)
- [2. Manual Upgrade via SSH](#2-manual-upgrade-via-ssh)
- [3. Upgrade OpenClaw Docker Image](#3-upgrade-openclaw-docker-image)
- [4. Post-Update Checklist](#4-post-update-checklist)

---

## 1. Upgrade via Management API (Recommended)

Call the `/api/self-update` endpoint to automatically download the latest version from GitHub and restart the service.

```bash
MGMT_KEY="<your_mgmt_api_key>"
VPS_IP="<your_vps_ip>"

curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/self-update
```

**Successful response:**

```json
{
  "ok": true,
  "message": "Update complete. Management API restarting...",
  "files": [
    { "file": "/opt/openclaw-mgmt/server.js", "ok": true },
    { "file": "/opt/openclaw/docker-compose.yml", "ok": true },
    { "file": "/etc/openclaw/config/anthropic.json", "ok": true },
    { "file": "/etc/openclaw/config/openai.json", "ok": true },
    { "file": "/etc/openclaw/config/gemini.json", "ok": true }
  ]
}
```

**Files updated:**

| File                | Path on VPS                             | Description                |
|---------------------|-----------------------------------------|----------------------------|
| server.js           | `/opt/openclaw-mgmt/server.js`          | Management API server      |
| docker-compose.yml  | `/opt/openclaw/docker-compose.yml`      | Docker Compose config      |
| anthropic.json      | `/etc/openclaw/config/anthropic.json`   | Anthropic template config  |
| openai.json         | `/etc/openclaw/config/openai.json`      | OpenAI template config     |
| gemini.json         | `/etc/openclaw/config/gemini.json`      | Gemini template config     |

> **Note:** The Management API will restart itself after updating. Connection may be lost for 2-3 seconds during restart.

---

## 2. Manual Upgrade via SSH

If Management API is not running or you want to upgrade manually:

```bash
ssh root@<VPS_IP>
```

### Step 1: Download new files from GitHub

```bash
REPO_RAW="https://raw.githubusercontent.com/Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management/main"

# Management API
curl -fsSL "$REPO_RAW/management-api/server.js" -o /opt/openclaw-mgmt/server.js

# Docker Compose
curl -fsSL "$REPO_RAW/docker-compose.yml" -o /opt/openclaw/docker-compose.yml

# Config templates
curl -fsSL "$REPO_RAW/config/anthropic.json" -o /etc/openclaw/config/anthropic.json
curl -fsSL "$REPO_RAW/config/openai.json" -o /etc/openclaw/config/openai.json
curl -fsSL "$REPO_RAW/config/gemini.json" -o /etc/openclaw/config/gemini.json
curl -fsSL "$REPO_RAW/config/chatgpt.json" -o /etc/openclaw/config/chatgpt.json
```

### Step 2: Restart Management API

```bash
systemctl restart openclaw-mgmt
systemctl status openclaw-mgmt
```

### Step 3: Apply Docker Compose changes (if new services are added)

```bash
cd /opt/openclaw
docker compose up -d
```

The `docker compose up -d` command will automatically create new containers if your `docker-compose.yml` has new services, without affecting running containers.

---

## 3. Upgrade OpenClaw Docker Image

To upgrade the OpenClaw Docker image (not the Management API), use the `/api/upgrade` endpoint:

```bash
curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/upgrade
```

Or manually via SSH:

```bash
cd /opt/openclaw
docker compose pull openclaw
docker compose up -d openclaw
```

---

## 4. Post-Update Checklist

### Check Management API

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/status
```

### Check containers

```bash
# Via API
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/status

# Via SSH
docker ps
```

### Check logs if errors occur

```bash
# Management API logs
journalctl -u openclaw-mgmt -f --no-pager -n 50

# OpenClaw container logs
cd /opt/openclaw && docker compose logs -f --tail=50
```
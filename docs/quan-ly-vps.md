# VPS & Docker Management

## Table of Contents

- [1. Common Docker Commands](#1-common-docker-commands)
- [2. Domain + SSL Configuration](#2-domain--ssl-configuration)
- [3. Upgrade Version](#3-upgrade-version)
- [4. View System Information](#4-view-system-information)
- [5. Reset to Default](#5-reset-to-default)
- [6. Troubleshooting](#6-troubleshooting)

---

## 1. Common Docker Commands

SSH into your VPS and run the following commands:

```bash
cd /opt/openclaw
```

### View logs

```bash
# View OpenClaw logs (follow mode)
docker compose logs -f openclaw

# View Caddy logs (reverse proxy)
docker compose logs -f caddy

# View last 200 lines
docker compose logs --tail=200 openclaw
```

Or via API:

```bash
curl -H "Authorization: Bearer $MGMT_KEY" \
  "http://$VPS_IP:9998/api/logs?lines=200&service=openclaw"
```

### Restart

```bash
docker compose restart openclaw
```

Or via API:

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/restart
```

### Stop / Start

```bash
# Stop
docker compose stop openclaw

# Start/Resume
docker compose start openclaw
```

Or via API:

```bash
# Stop
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/stop

# Start
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/start
```

### Rebuild (recreate containers)

```bash
docker compose down && docker compose up -d
```

Or via API:

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/rebuild
```

### Check status

```bash
docker compose ps
```

Or via API:

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/status
```

### Run CLI command in container

```bash
docker compose exec openclaw node dist/index.js models scan
docker compose exec openclaw node dist/index.js config get
```

Or via API:

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "models scan"}' \
  http://$VPS_IP:9998/api/cli
```

---

## 2. Domain + SSL Configuration

### View current domain

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/domain
```

### Change domain (auto configure Let's Encrypt SSL)

**Requirement:** The domain's DNS (A record) must already point to the VPS IP.

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "openclaw.example.com"}' \
  http://$VPS_IP:9998/api/domain
```

Optional: add email for Let's Encrypt:

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "openclaw.example.com", "email": "admin@example.com"}' \
  http://$VPS_IP:9998/api/domain
```

> **Note:**
> - Domain must be lowercase, no `https://`
> - DNS must resolve to the correct VPS IP, else API will error
> - If Caddy cannot start with the new domain, the system will automatically roll back to IP configuration

### Manual configuration on VPS

Edit `/opt/openclaw/Caddyfile`:

**For domain:**
```
openclaw.example.com {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
        }
    }
    reverse_proxy openclaw:18789
}
```

**For IP (self-signed):**
```
180.93.138.155 {
    tls internal
    reverse_proxy openclaw:18789
}
```

After editing, restart Caddy:

```bash
docker compose restart caddy
```

---

## 3. Upgrade Version

### Via SSH

```bash
cd /opt/openclaw
docker compose pull && docker compose up -d
```

### Via API

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/upgrade
```

> The API returns immediately with `202 Accepted`, the image pull runs in the background. Check status with `/api/status`.

### View current version

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/version
```

---

## 4. View System Information

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/system
```

Sample response:

```json
{
  "ok": true,
  "hostname": "openclaw1",
  "ip": "180.93.138.155",
  "os": "Ubuntu 24.04 LTS",
  "uptime": 86400,
  "loadAvg": [0.5, 0.3, 0.2],
  "memory": {
    "total": "4096MB",
    "free": "2048MB",
    "used": "2048MB"
  },
  "disk": {
    "total": "80G",
    "used": "15G",
    "available": "65G",
    "usagePercent": "19%"
  },
  "nodeVersion": "v22.0.0",
  "dockerVersion": "Docker version 27.0.0"
}
```

---

## 5. Reset to Default

> **WARNING:** This operation will **DELETE ALL data** and configuration, returning to initial state.

```bash
curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"confirm": "RESET"}' \
  http://$VPS_IP:9998/api/reset
```

The system will:
1. Stop all containers
2. Delete data and volumes
3. Restore default configuration (Anthropic)
4. Restart

> You must send `{"confirm": "RESET"}` to confirm. Otherwise, it will error.

---

## 6. Troubleshooting

### OpenClaw does not start

```bash
# Check status
docker compose ps

# View error logs
docker compose logs --tail=50 openclaw

# Try restarting
docker compose restart openclaw

# If still broken, rebuild
docker compose down && docker compose up -d
```

### Cannot access Dashboard

1. **Check container is running:**
   ```bash
   docker compose ps
   ```

2. **Check firewall:**
   ```bash
   ufw status
   # Ports 80 and 443 must be allowed
   ```

3. **Check Caddy:**
   ```bash
   docker compose logs caddy
   ```

4. **Check DNS** (if using domain):
   ```bash
   dig openclaw.example.com
   # Should return VPS IP
   ```

### API key does not work

1. **Check key validity:**
   ```bash
   curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
     -H "Content-Type: application/json" \
     -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx"}' \
     http://$VPS_IP:9998/api/config/test-key
   ```

2. **Check auth-profiles.json:**
   ```bash
   cat /opt/openclaw/config/agents/main/agent/auth-profiles.json
   ```

3. **Update the key:**
   ```bash
   curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
     -H "Content-Type: application/json" \
     -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx-new"}' \
     http://$VPS_IP:9998/api/config/api-key
   ```

### SSL not working

1. **Check DNS points correctly:**
   ```bash
   dig +short your-domain.com
   # Should return VPS IP
   ```

2. **Check Caddy logs:**
   ```bash
   docker compose logs caddy | grep -i "tls\|acme\|certificate"
   ```

3. **Try changing domain again:**
   ```bash
   curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
     -H "Content-Type: application/json" \
     -d '{"domain": "your-domain.com"}' \
     http://$VPS_IP:9998/api/domain
   ```

### Management API is unresponsive

```bash
# Check service
systemctl status openclaw-mgmt

# Restart service
systemctl restart openclaw-mgmt

# View logs
journalctl -u openclaw-mgmt -f
```

### Important environment variables — Do not delete

The following variables in `/opt/openclaw/.env` **MUST NOT BE DELETED** – if missing you will lose system access:

| Variable                | Description                                              |
|-------------------------|---------------------------------------------------------|
| `OPENCLAW_GATEWAY_TOKEN`| Dashboard access token                                  |
| `OPENCLAW_MGMT_API_KEY` | API management key (issued by my.hitechcloud.vn; do not change) |
| `OPENCLAW_VERSION`      | OpenClaw version                                        |
| `OPENCLAW_GATEWAY_PORT` | Internal gateway port                                   |
# Internal Documentation — Error Handling & Troubleshooting

> Documentation for the hitechcloud.vn engineering team. Do not share with customers.

## Table of Contents

- [1. Error Handling Architecture](#1-error-handling-architecture)
- [2. HTTP Error Codes and Meanings](#2-http-error-codes-and-meanings)
- [3. Timeout Values by Operation Type](#3-timeout-values-by-operation-type)
- [4. Authentication Error Handling](#4-authentication-error-handling)
- [5. Docker Error Handling](#5-docker-error-handling)
- [6. File I/O Error Handling](#6-file-io-error-handling)
- [7. DNS & Domain Error Handling](#7-dns--domain-error-handling)
- [8. API Key Test Error Handling](#8-api-key-test-error-handling)
- [9. Security — Shell Injection Prevention](#9-security--shell-injection-prevention)
- [10. Protected Environment Variables](#10-protected-environment-variables)
- [11. Common Errors and How to Fix](#11-common-errors-and-how-to-fix)
- [12. Note on Race Condition](#12-note-on-race-condition)
- [13. Debug Commands on VPS](#13-debug-commands-on-vps)

---

## 1. Error Handling Architecture

Management API (`server.js`) error handling flow:

```
Request → Auth check → Rate limit check → Route handler → try/catch → Response
```

- **Each route** is wrapped in `try-catch`. If any exception, returns `500` with `e.message`.
- **Shell commands** use `execSync()` — throws on non-zero exit code or timeout.
- **File operations** use `readFileSync()` / `writeFileSync()` — throws if file missing or write error.

Unified error response format:

```json
{"ok": false, "error": "Error description"}
```

---

## 2. HTTP Error Codes and Meanings

| HTTP Code | When does it occur                   | Action                              |
|-----------|--------------------------------------|-------------------------------------|
| `200`     | Success (sync)                       | —                                   |
| `202`     | Success, processing in background    | Client should poll `/api/status`    |
| `400`     | Invalid input data                   | Check request body                  |
| `401`     | Missing/wrong Bearer token           | Check `OPENCLAW_MGMT_API_KEY` in `.env` |
| `403`     | Tried to modify/delete protected var | That variable cannot be changed     |
| `429`     | IP blocked (10+ auth failures)       | Wait 15 mins or restart mgmt service|
| `500`     | Server error (shell timeout, file I/O, Docker fail) | See logs: `journalctl -u openclaw-mgmt` |

---

## 3. Timeout Values by Operation Type

| Operation                | Timeout   | Note                           |
|--------------------------|-----------|--------------------------------|
| Default shell command    | 30s       | `shell()` function             |
| Docker compose (general) | 60s       | restart, stop, start           |
| Docker compose down      | 60s       | Graceful shutdown              |
| Docker compose up        | 120s      | Rebuild/start                  |
| Docker pull + recreate   | 300s (5m) | `/api/upgrade` — runs in bg    |
| Docker exec (CLI proxy)  | 60s       | `/api/cli`                     |
| DNS lookup (dig/host)    | 10s       | Validate domain                |
| API key test (curl)      | 15s       | Test provider endpoints        |
| Caddy restart (domain)   | 30s       | After writing Caddyfile        |
| Caddy rollback restart   | 15s       | When Caddy fails with new domain|

---

## 4. Authentication Error Handling

### Mechanism

- Bearer token checked with `crypto.timingSafeEqual()` — prevents timing attack.
- API key read from `.env` on each request (no cache).
- IP-based rate limit: **10 bad attempts → block for 15 mins**.

### Failure Modes

| Error                       | Cause                          | Response |
|-----------------------------|-------------------------------|----------|
| Missing `Authorization` hdr | Client did not send header     | 401      |
| Bad format (no `Bearer `)   | Header fails `/^Bearer\s+(.+)$/` regex | 401      |
| Wrong token value           | Key does not match `.env`      | 401 + fail count up |
| Wrong token length          | `Buffer.from()` length mismatch| 401      |
| `.env` missing mgmt key     | Key becomes empty              | 401 (always fails) |
| IP blocked                  | 10+ failures                   | 429      |

### Notes

- Rate limit is **in-memory** — restarting service resets block.
- Cleanup runs only when a blocked IP accesses after 15 minutes.
- **No persistent storage** for rate limiting — possible memory leak if under widespread attack.

### Unblock a blocked IP

```bash
# Easiest: restart management API
systemctl restart openclaw-mgmt
```

---

## 5. Docker Error Handling

### Container not found

- `docker inspect` throws exception → catch and return `status: "not_found"`.
- This is not a 500, just a normal response.

### Restart fail

- `docker compose restart openclaw` throws → handled at route level → 500.
- Common causes: corrupt image, disk full, OOM.

### Caddy rollback on domain failure

Domain change process:

```
1. Write new Caddyfile (domain + Let's Encrypt)
2. Restart Caddy (30s timeout)
3. Sleep 3s
4. Check Caddy status
   ├── running → 200 OK
   └── not running → ROLLBACK:
       ├── Write Caddyfile with IP + tls internal
       ├── Restart Caddy (15s timeout)
       └── Return 500 "Caddy failed to start..."
```

**Limitation:** If rollback fails, the error is silently caught. Caddy remains stopped, needs manual fix.

### Rebuild fail

```
docker compose down (60s) → docker compose up -d (120s)
```

- If `down` times out → `up` is NOT called → container is in unknown state.
- If `up` fails → container is `stopped`.

### Post-restart/rebuild checking

API sleeps 2-3 seconds then checks status. If container not ready after sleep, returned status may be inaccurate. No retry loop.

---

## 6. File I/O Error Handling

### Important files

| File                                    | Consequence if corrupt/lost                  |
|------------------------------------------|----------------------------------------------|
| `/opt/openclaw/.env`                     | Auth fails (MGMT key lost), lost tokens      |
| `/opt/openclaw/config/openclaw.json`     | 500 on all config endpoints                  |
| `auth-profiles.json`                     | AI keys lost, but falls back to env vars     |
| `/opt/openclaw/Caddyfile`                | Caddy fails, SSL lost                       |
| `/etc/openclaw/config/*.json`            | Cannot change provider                       |

### auth-profiles.json — Graceful fallback

```javascript
// If file missing or JSON error → return { profiles: {} }
// DO NOT throw 500
```

### openclaw.json — NO graceful fallback

```javascript
// JSON.parse() throws → 500 error
// Manual fix or copy from template needed
```

### Writes are NOT atomic

- `writeFileSync()` overwrites directly, no backup.
- If the process crashes mid-write → file may be empty/corrupt.
- **No file locking** — concurrent writes may corrupt file.

### Recovering from corrupted config

```bash
# Copy default config template
cp /etc/openclaw/config/anthropic.json /opt/openclaw/config/openclaw.json

# Inject gateway token
TOKEN=$(grep OPENCLAW_GATEWAY_TOKEN /opt/openclaw/.env | cut -d= -f2)
jq --arg t "$TOKEN" '.gateway.auth.token = $t' \
  /opt/openclaw/config/openclaw.json > /tmp/oc.json && \
  mv /tmp/oc.json /opt/openclaw/config/openclaw.json

# Restart
docker compose -f /opt/openclaw/docker-compose.yml restart openclaw
```

---

## 7. DNS & Domain Error Handling

### DNS validation flow

```
1. Receive domain from request
2. Lowercase + regex format validation
3. dig +short A domain (10s timeout)
   ├── Has result → filter IP format
   └── No result → fallback:
       host domain (10s timeout)
       ├── "has address X.X.X.X" → parse IP
       └── No → error
4. Compare resolved IPs vs server IP
   ├── Match → OK
   └── Mismatch → 400 error
```

### DNS errors

| Error                  | Message                                                          | Cause                  |
|------------------------|------------------------------------------------------------------|------------------------|
| Cannot resolve         | `"Cannot resolve DNS for {domain}. Point A record to {ip}."`     | DNS not set or not propagated |
| IP mismatch            | `"DNS for {domain} resolves to {ips} — does not match server IP ({ip})."` | DNS points to wrong IP |
| Bad domain format      | `"Invalid domain format"`                                        | Invalid chars, uppercase, trailing dot |

### Limitations

- **IPv4 only** (A record). Does not check AAAA (IPv6).
- Both `dig` and `host` time out at 10s. If DNS slow → false negative.
- DNS propagation may take up to 48h. Clients calling API too soon get rejected.

---

## 8. API Key Test Error Handling

### How each provider is tested

| Provider   | Method         | URL                                       | Criteria   |
|------------|---------------|--------------------------------------------|------------|
| Anthropic  | POST `/v1/messages` | `api.anthropic.com`                   | HTTP 200   |
| OpenAI     | GET `/v1/models`    | `api.openai.com`                      | HTTP 200   |
| Gemini     | GET `/v1beta/models`| `generativelanguage.googleapis.com`    | HTTP 200   |

### Failure Modes

| Situation           | Provider HTTP code     | Test result         |
|---------------------|-----------------------|---------------------|
| Valid key           | 200                   | `ok: true`          |
| Invalid/expired key | 401                   | `ok: false`         |
| Quota exceeded      | 429                   | `ok: false`         |
| Provider down       | 503                   | `ok: false`         |
| Timeout (>15s)      | — (exception thrown)  | `ok: false`         |

### Notes

- Test endpoint does NOT save the key; simply checks and returns result.
- API key has single quotes escaped before passing to curl: `'` → `'\''`.
- Any non-200 provider response (including 201, 204) → considered fail.

---

## 9. Security — Shell Injection Prevention

### CLI Proxy (`/api/cli`)

**Blocked characters:** `;`, `&`, `|`, `` ` ``, `$`, `(`, `)`, `{`, `}`

```javascript
if (/[;&|`$(){}]/.test(command)) {
  return 400 "Command contains disallowed characters"
}
```

Command executed:
```bash
docker compose exec -T openclaw node dist/index.js <command>
```

### Known issues

- **Redirect `>`, `<`** are NOT blocked. Example: `models scan > /tmp/file` will still run.
- However, command runs **inside container** (not host), so risk is limited.

### Other security points

| Area                    | Security                                    |
|-------------------------|---------------------------------------------|
| Domain in dig/host      | Regex validated before placing in shell     |
| API key in curl test    | Single quote escaping                       |
| Docker commands         | Hardcoded, no user input                    |
| Env var key             | Regex `/^[A-Z][A-Z0-9_]*$/`                 |

---

## 10. Protected Environment Variables

### Not allowed to modify via `PUT /api/env/:key`

| Variable                 | Reason                                |
|--------------------------|---------------------------------------|
| `OPENCLAW_MGMT_API_KEY`  | Generated by HostBill/my.hitechcloud.vn; changing breaks panel-VPS link |

→ Returns `403 Forbidden`.

### Not allowed to delete via `DELETE /api/env/:key`

| Variable                   | Reason                            |
|----------------------------|-----------------------------------|
| `OPENCLAW_GATEWAY_TOKEN`   | Lose dashboard access             |
| `OPENCLAW_MGMT_API_KEY`    | Lose panel connection             |
| `OPENCLAW_VERSION`         | Needed for Docker image tag       |
| `OPENCLAW_GATEWAY_PORT`    | Needed for gateway binding        |

→ Returns `403 Forbidden`.

---

## 11. Common Errors and How to Fix

### 11.1 — 429: IP blocked after many failed auth

**Symptoms:** All API calls return 429.

**Cause:** Client sent wrong key >= 10 times.

**Fix:**
```bash
# Wait 15 mins, or:
systemctl restart openclaw-mgmt
```

### 11.2 — 401: Auth always fails even with correct key

**Symptoms:** Correct key always gets 401.

**Cause:** `OPENCLAW_MGMT_API_KEY` in `.env` is empty or wrong.

**Fix:**
```bash
# Check the key
grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env

# If empty, get key from HostBill and update it
# (Contact HostBill admin for original key)
```

### 11.3 — 500: Config JSON corrupt

**Symptoms:** All config calls return 500.

**Check:**
```bash
cat /opt/openclaw/config/openclaw.json | jq .
# If jq reports parse error → file is corrupt
```

**Fix:**
```bash
cp /etc/openclaw/config/anthropic.json /opt/openclaw/config/openclaw.json
TOKEN=$(grep OPENCLAW_GATEWAY_TOKEN /opt/openclaw/.env | cut -d= -f2)
jq --arg t "$TOKEN" '.gateway.auth.token = $t' \
  /opt/openclaw/config/openclaw.json > /tmp/oc.json && \
  mv /tmp/oc.json /opt/openclaw/config/openclaw.json
docker compose -f /opt/openclaw/docker-compose.yml restart openclaw
```

### 11.4 — Caddy won't start after domain change

**Symptoms:** API returns 500 "Caddy failed to start". Dashboard is inaccessible.

**Check:**
```bash
docker compose -f /opt/openclaw/docker-compose.yml logs caddy
cat /opt/openclaw/Caddyfile
```

**Common causes:**
- DNS hasn't propagated → Let's Encrypt challenge fails
- Let's Encrypt rate limit (5 certs/domain/week)
- Port 80/443 blocked by firewall

**Fix:** API will auto-rollback config. If still error:
```bash
# Manually reset Caddyfile
IP=$(hostname -I | awk '{print $1}')
cat > /opt/openclaw/Caddyfile << EOF
${IP} {
    tls internal
    reverse_proxy openclaw:18789
}
EOF
docker compose -f /opt/openclaw/docker-compose.yml restart caddy
```

### 11.5 — Upgrade never completes

**Symptoms:** Call to `/api/upgrade` returns 202 but container does not update.

**Check:**
```bash
journalctl -u openclaw-mgmt --since "10 minutes ago" | grep -i upgrade
docker compose -f /opt/openclaw/docker-compose.yml ps
```

**Manual fix:**
```bash
cd /opt/openclaw
docker compose pull openclaw
docker compose up -d openclaw
```

### 11.6 — Container in endless restart loop (crash loop)

**Symptoms:** Status is always `exited` or `restarting`.

**Check:**
```bash
docker compose -f /opt/openclaw/docker-compose.yml logs --tail=50 openclaw
```

**Common causes:**
- Config JSON format error
- Invalid API key (model provider rejected)
- Disk full
- OOM (out of memory)

**Fix:**
```bash
# Check disk
df -h /

# Check RAM
free -m

# Reset config if needed
cp /etc/openclaw/config/anthropic.json /opt/openclaw/config/openclaw.json
docker compose -f /opt/openclaw/docker-compose.yml restart openclaw
```

### 11.7 — Management API does not respond

**Symptoms:** Cannot connect to port 9998.

**Check:**
```bash
systemctl status openclaw-mgmt
journalctl -u openclaw-mgmt -f
ufw status | grep 9998
ss -tlnp | grep 9998
```

**Fix:**
```bash
systemctl restart openclaw-mgmt

# If still broken, check Node.js
node --version
cat /opt/openclaw-mgmt/server.js | head -5
```

### 11.8 — auth-profiles.json missing/corrupt

**Symptoms:** AI key missing, bot does not reply.

**Note:** Corrupt auth-profiles.json does NOT cause 500 — system falls back to env vars.

**Check:**
```bash
cat /opt/openclaw/config/agents/main/agent/auth-profiles.json | jq .
```

**Fix:** Re-set key via API:
```bash
MGMT_KEY=$(grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env | cut -d= -f2)
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-new-key"}' \
  http://localhost:9998/api/config/api-key
```

---

## 12. Note on Race Condition

Management API **has NO file locking**. All read-modify-write operations are non-atomic:

| File           | Affected operations                                 |
|----------------|-----------------------------------------------------|
| `.env`         | `PUT /api/env`, `PUT /api/config/api-key`, `PUT /api/channels/:ch` |
| `openclaw.json`| `PUT /api/config/provider`, `PUT /api/channels/:ch`, `DELETE /api/channels/:ch` |
| `auth-profiles.json` | `PUT /api/config/api-key`, `PUT /api/config/provider` |

**Risk:** If 2 requests modify the same file at the same time, the later write overwrites the earlier one.

**Mitigation:** HostBill panel should serialize API calls (do not call in parallel).

---

## 13. Debug Commands on VPS

### Quick health check of the whole system

```bash
# All services status
docker compose -f /opt/openclaw/docker-compose.yml ps
systemctl status openclaw-mgmt

# OpenClaw logs
docker compose -f /opt/openclaw/docker-compose.yml logs --tail=30 openclaw

# Caddy logs
docker compose -f /opt/openclaw/docker-compose.yml logs --tail=30 caddy

# Management API logs
journalctl -u openclaw-mgmt --since "30 minutes ago" --no-pager

# Current config
cat /opt/openclaw/config/openclaw.json | jq .

# API keys
cat /opt/openclaw/config/agents/main/agent/auth-profiles.json 2>/dev/null | jq .

# Env vars
grep -v '^#' /opt/openclaw/.env | grep -v '^$'

# Firewall
ufw status

# Disk + RAM
df -h / && free -m

# Caddyfile
cat /opt/openclaw/Caddyfile
```

### Test Management API from VPS

```bash
MGMT_KEY=$(grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env | cut -d= -f2)

# Health check
curl -s -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/status | jq .

# View config
curl -s -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/config | jq .

# View system info
curl -s -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/system | jq .
```

### Full recovery (worst case)

```bash
cd /opt/openclaw

# Stop everything
docker compose down

# Reset config
cp /etc/openclaw/config/anthropic.json config/openclaw.json
TOKEN=$(grep OPENCLAW_GATEWAY_TOKEN .env | cut -d= -f2)
jq --arg t "$TOKEN" '.gateway.auth.token = $t' config/openclaw.json > /tmp/oc.json
mv /tmp/oc.json config/openclaw.json

# Restart
docker compose up -d
systemctl restart openclaw-mgmt

# Verify
docker compose ps
curl -s -H "Authorization: Bearer $(grep OPENCLAW_MGMT_API_KEY .env | cut -d= -f2)" \
  http://localhost:9998/api/status | jq .
```
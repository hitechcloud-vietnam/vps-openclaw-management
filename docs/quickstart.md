# Quick Start with OpenClaw

## Table of Contents

- [1. Access Dashboard](#1-access-dashboard)
- [2. Add AI API Key](#2-add-ai-api-key)
- [3. Send Your First Message](#3-send-your-first-message)
- [4. Change AI Model](#4-change-ai-model)
- [5. Directory Structure on VPS](#5-directory-structure-on-vps)
- [6. Basic Management Commands](#6-basic-management-commands)

---

## 1. Access Dashboard

After VPS installation, access your Dashboard via browser:

```
https://<domain-or-ip>?token=<gateway-token>
```

**Examples:**
- With domain: `https://openclaw.example.com?token=abc123...`
- IP only: `https://180.93.138.155?token=abc123...`

> **Note:** If using IP (no domain), your browser will warn about self-signed SSL—click **"Advanced"** → **"Proceed"** to continue.

**Login information** is given in the management panel at my.hitechcloud.vn:
- **Gateway Token** — used to access the Dashboard
- **Management API Key** — generated and managed by my.hitechcloud.vn, used to connect the panel to the VPS

> **Important:** Do not manually change or delete `OPENCLAW_MGMT_API_KEY` in the `.env` file on your VPS. If changed, the panel at my.hitechcloud.vn will not be able to connect to your VPS.

---

## 2. Add AI API Key

OpenClaw requires an API key from your selected AI provider to function. Three providers are supported:

| Provider              | Get API key at                             |
|-----------------------|--------------------------------------------|
| Anthropic (Claude)    | https://console.anthropic.com/settings/keys|
| OpenAI (GPT)          | https://platform.openai.com/api-keys       |
| Google (Gemini)       | https://aistudio.google.com/apikey         |

### Add API key via my.hitechcloud.vn panel

The panel will call the Management API to update your key:

```bash
MGMT_KEY="<management-api-key>"
VPS_IP="<ip-vps>"

curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx..."}' \
  http://$VPS_IP:9998/api/config/api-key
```

**Check key validity before saving:**

```bash
curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx..."}' \
  http://$VPS_IP:9998/api/config/test-key
```

Result: `{"ok": true}` if the key is valid.

---

## 3. Send Your First Message

1. Access the Dashboard with the URL from Step 1
2. Ensure you've added your API key as in Step 2
3. Type a message in the chat box and press Enter
4. OpenClaw will reply using the configured AI model

---

## 4. Change AI Model

OpenClaw uses `anthropic/claude-opus-4-5` by default. To switch models:

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "model": "anthropic/claude-sonnet-4-20250514"}' \
  http://$VPS_IP:9998/api/config/provider
```

> See more model options in [Detailed Configuration](cau-hinh.md).

---

## 5. Directory Structure on VPS

```
/opt/openclaw/                          # Main directory
├── docker-compose.yml                  # Docker services config
├── Caddyfile                           # Reverse proxy + SSL config
├── .env                                # Environment variables (tokens, API keys)
├── config/
│   ├── openclaw.json                   # Current configuration (model, gateway, browser)
│   └── agents/main/agent/
│       └── auth-profiles.json          # API keys (OpenClaw standard format)
└── data/                               # Persistent data

/opt/openclaw-mgmt/
└── server.js                           # Management API (port 9998)

/etc/openclaw/config/                   # Configuration templates (do not edit)
├── anthropic.json
├── openai.json
└── gemini.json
```

---

## 6. Basic Management Commands

SSH into your VPS and run:

```bash
cd /opt/openclaw

# View logs
docker compose logs -f openclaw

# Restart
docker compose restart openclaw

# Update to latest version
docker compose pull && docker compose up -d

# Stop everything
docker compose down
```

> See more in [VPS & Docker Management](quan-ly-vps.md).

---

## Next Steps

- [Detailed Configuration](cau-hinh.md) — Change model, configure gateway, browser
- [Messaging Channels Connection](kenh-nhan-tin.md) — Telegram, Discord, Zalo, Slack
- [VPS & Docker Management](quan-ly-vps.md) — Domain, SSL, Docker commands
- [API Reference](api-reference.md) — Full API endpoints list
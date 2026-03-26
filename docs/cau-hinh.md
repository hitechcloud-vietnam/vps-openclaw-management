# Detailed Configuration

## Table of Contents

- [1. Change AI Model](#1-change-ai-model)
- [2. Manage API Keys](#2-manage-api-keys)
- [3. Gateway Configuration](#3-gateway-configuration)
- [4. Browser Configuration](#4-browser-configuration)
- [5. .env File — Environment Variables](#5-env-file--environment-variables)
- [6. View Current Configuration](#6-view-current-configuration)

---

## 1. Change AI Model

### Supported Providers

| Provider                  | Provider ID | Default Model                      |
|---------------------------|-------------|------------------------------------|
| Anthropic (Claude)        | `anthropic` | `anthropic/claude-opus-4-5`        |
| OpenAI (GPT)              | `openai`    | `openai/gpt-5.2`                   |
| Google (Gemini)           | `gemini`    | `google/gemini-2.5-pro`            |

### Popular Models List

**Anthropic:**

| Model               | ID                                   |
|---------------------|--------------------------------------|
| Claude Opus 4.5     | `anthropic/claude-opus-4-5`          |
| Claude Sonnet 4     | `anthropic/claude-sonnet-4-20250514` |
| Claude Haiku 3.5    | `anthropic/claude-haiku-3-5-20241022`|

**OpenAI:**

| Model        | ID                    |
|--------------|-----------------------|
| GPT-5.2      | `openai/gpt-5.2`      |
| GPT-4o       | `openai/gpt-4o`       |
| GPT-4o Mini  | `openai/gpt-4o-mini`  |

**Google Gemini:**

| Model             | ID                      |
|-------------------|------------------------|
| Gemini 2.5 Pro    | `google/gemini-2.5-pro`|
| Gemini 2.5 Flash  | `google/gemini-2.5-flash`|

### Change Model via API

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "model": "anthropic/claude-sonnet-4-20250514"}' \
  http://$VPS_IP:9998/api/config/provider
```

> **Note:** When switching providers, the corresponding API key must be set. For example, switching to `openai` requires an OpenAI API key.

---

## 2. Manage API Keys

### API Key Reading Priority

1. **auth-profiles.json** (highest priority)
2. **Environment variables** in `.env` (fallback)

### Update API Key via API

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx..."}' \
  http://$VPS_IP:9998/api/config/api-key
```

The API automatically saves the key to both `auth-profiles.json` and `.env`, then restarts OpenClaw.

### Check API Key Validity

```bash
curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx..."}' \
  http://$VPS_IP:9998/api/config/test-key
```

Results:
- `{"ok": true}` — Key is valid
- `{"ok": false, "error": "API key invalid or expired"}` — Key is invalid

### Provider Mapping

| Provider      | Environment Variable     | Profile Provider |
|---------------|-------------------------|------------------|
| `anthropic`   | `ANTHROPIC_API_KEY`     | `anthropic`      |
| `openai`      | `OPENAI_API_KEY`        | `openai`         |
| `gemini`      | `GEMINI_API_KEY`        | `google`         |

### auth-profiles.json Format

File: `/opt/openclaw/config/agents/main/agent/auth-profiles.json`

```json
{
  "profiles": {
    "anthropic:manual": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-xxx..."
    },
    "google:manual": {
      "type": "api_key",
      "provider": "google",
      "key": "AIzaSy..."
    }
  }
}
```

> **Important:**
> - `type` must be `"api_key"` (underscore, NOT `"api-key"`)
> - Key field is `"key"` (NOT `"apiKey"`)
> - Gemini's provider in profiles is `"google"` (NOT `"gemini"`)

---

## 3. Gateway Configuration

Config file: `/opt/openclaw/config/openclaw.json`

```json
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": {
      "token": "<gateway-token>"
    },
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true
    }
  }
}
```

| Parameter                | Description                          | Default Value           |
|--------------------------|--------------------------------------|------------------------|
| `mode`                   | Gateway mode                         | `"local"`              |
| `bind`                   | Interface binding                    | `"lan"`                |
| `auth.token`             | Dashboard authentication token        | Auto-generated (64-char hex) |
| `trustedProxies`         | Trusted IP ranges (Caddy proxy)      | Docker + private nets  |
| `controlUi.enabled`      | Enable/disable web UI                | `true`                 |
| `controlUi.allowInsecureAuth` | Bypass device pairing           | `true`                 |

---

## 4. Browser Configuration

```json
{
  "browser": {
    "headless": true,
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
```

| Parameter         | Description                                 | Default Value     |
|-------------------|---------------------------------------------|------------------|
| `headless`        | Headless mode (no UI)                       | `true`           |
| `defaultProfile`  | Name of browser profile                     | `"openclaw"`     |
| `noSandbox`       | Disable sandbox (required for Docker)        | `true`           |

---

## 5. .env File — Environment Variables

File: `/opt/openclaw/.env`

```bash
# Version
OPENCLAW_VERSION=latest

# Gateway
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_TOKEN=<gateway-token>

# Management API (generated by my.hitechcloud.vn — DO NOT DELETE/EDIT)
OPENCLAW_MGMT_API_KEY=<mgmt-api-key>

# AI Provider API Keys (uncomment and fill)
# ANTHROPIC_API_KEY=sk-ant-xxx
# OPENAI_API_KEY=sk-xxx
# GEMINI_API_KEY=AIzaSy...

# Messaging Channels (uncomment and fill)
# TELEGRAM_BOT_TOKEN=123456789:ABCdef...
# DISCORD_BOT_TOKEN=xxx
# SLACK_BOT_TOKEN=xoxb-xxx
# ZALO_BOT_TOKEN=xxx
```

### Manage env via API

**View all variables** (sensitive values are masked):

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/env
```

**Add/update a variable:**

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value": "your-value"}' \
  http://$VPS_IP:9998/api/env/CUSTOM_VAR
```

**Delete a variable:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/env/CUSTOM_VAR
```

> **Protected variables** (cannot be deleted): `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_MGMT_API_KEY`, `OPENCLAW_VERSION`, `OPENCLAW_GATEWAY_PORT`

---

## 6. View Current Configuration

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/config
```

Returns full configuration, including:
- Current provider and model
- API keys (masked)
- Configuration of channels, gateway, browser, plugins
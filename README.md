# OpenClaw - VPS Management

Deploy and manage [OpenClaw](https://github.com/openclaw/openclaw) on any VPS with a single command. Includes Docker Compose, automatic SSL via Caddy, and a REST Management API for remote administration.

## Features

- **One-command installer** — Automatically sets up Docker, OpenClaw, Caddy reverse proxy, firewall, and fail2ban
- **Management API** — REST API (port 9998) for remote management via HostBill or any HTTP client
- **Multi-AI provider** — 21 built-in providers supported + custom OpenAI-compatible providers
- **Messaging Channels** — Integrated support for Telegram, Discord, Slack, Zalo OA
- **Automatic SSL** — Let's Encrypt via Caddy, or self-signed cert for IP access
- **Security** — UFW firewall, fail2ban, Bearer API key authentication with rate limiting

## Quick Start

### Install on VPS

```bash
curl -fsSL https://raw.githubusercontent.com/Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management/main/install.sh | bash
```

With options:

```bash
curl -fsSL https://raw.githubusercontent.com/Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management/main/install.sh | \
  bash -s -- --mgmt-key <YOUR_MGMT_KEY> --domain <YOUR_DOMAIN>
```

| Option        | Description                                                        |
|---------------|--------------------------------------------------------------------|
| `--mgmt-key`  | API key for Management API (auto-generated if not provided)        |
| `--domain`    | Domain name already pointed by DNS (enables Let's Encrypt SSL)     |

### After installation

The install script will output your login info:

```
Dashboard: https://<host>?token=<gateway_token>
Management API: http://<ip>:9998
MGMT API Key: <mgmt_key>
```

## Architecture

```
Internet
  │
  ├── :80/:443 ──► Caddy (reverse proxy + TLS)
  │                  │
  │                  └──► OpenClaw (:18789)
  │                         ├── Gateway (WebSocket)
  │                         ├── Control UI (dashboard)
  │                         └── Messaging channels (Telegram, Zalo, ...)
  │
  └── :9998 ────► Management API (Node.js on host)
```

### VPS Directory Structure

```
/opt/openclaw/                      # Main directory
├── docker-compose.yml
├── .env                            # Tokens, API keys
├── Caddyfile                       # Caddy config
├── config/
│   ├── openclaw.json               # Active configuration
│   └── agents/main/agent/
│       └── auth-profiles.json      # API key info
└── data/                           # Persistent data

/opt/openclaw-mgmt/
└── server.js                       # Management API

/etc/openclaw/config/               # Config templates (read-only)
├── anthropic.json
├── openai.json
└── gemini.json
```

## Management API

**Address**: `http://<ip>:9998`  
**Authentication**: `Authorization: Bearer <OPENCLAW_MGMT_API_KEY>`

### Service Info

| Method | Endpoint                            | Description                                     |
|--------|-------------------------------------|-------------------------------------------------|
| `GET`  | `/api/info`                        | Dashboard URL, token, status                    |
| `GET`  | `/api/status`                      | Container status (openclaw + caddy)             |
| `GET`  | `/api/system`                      | CPU, memory, disk, OS information               |
| `GET`  | `/api/version`                     | Image version and digest                        |
| `GET`  | `/api/logs?lines=100&service=openclaw` | Container logs                                 |

### Container Management

| Method | Endpoint             | Description                                             |
|--------|----------------------|--------------------------------------------------------|
| `POST` | `/api/restart`      | Restart OpenClaw container                             |
| `POST` | `/api/stop`         | Stop OpenClaw container                                |
| `POST` | `/api/start`        | Start OpenClaw container                               |
| `POST` | `/api/rebuild`      | Recreate containers (down + up)                        |
| `POST` | `/api/upgrade`      | Pull the latest image and recreate container           |
| `POST` | `/api/reset`        | Reset to defaults (requires `{"confirm":"RESET"}`)     |

### Providers and Models

| Method | Endpoint                        | Description                                   |
|--------|---------------------------------|-----------------------------------------------|
| `GET`  | `/api/providers`               | List all built-in & custom providers + models |
| `GET`  | `/api/config`                  | Current config (model, provider, masked keys) |
| `PUT`  | `/api/config/provider`         | Switch provider (built-in & custom)           |
| `PUT`  | `/api/config/api-key`          | Set API key for provider                      |
| `POST` | `/api/config/test-key`         | Validate API key                              |
| `POST` | `/api/providers/:provider/models` | Add model to provider                       |
| `DELETE`| `/api/providers/:provider/models/:modelId` | Remove model from provider          |

**Change built-in provider:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"gemini","model":"google/gemini-2.5-flash"}' \
  http://localhost:9998/api/config/provider
```

21 built-in providers: `anthropic`, `openai`, `gemini`, `deepseek`, `groq`, `together`, `mistral`, `xai`, `cerebras`, `sambanova`, `fireworks`, `cohere`, `yi`, `baichuan`, `stepfun`, `siliconflow`, `novita`, `openrouter`, `minimax`, `moonshot`, `zhipu`

**Set API key:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"gemini","apiKey":"AIzaSy..."}' \
  http://localhost:9998/api/config/api-key
```

API key is saved to both `.env` (fallback) and `auth-profiles.json` (main, used by OpenClaw).

**Add a new model to a provider:**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"claude-opus-4-6","name":"Claude Opus 4.6"}' \
  http://localhost:9998/api/providers/anthropic/models
```

**Remove a model:**

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" \
  http://localhost:9998/api/providers/anthropic/models/claude-opus-4-6
```

Works with built-in and custom providers. User-added models are persisted and not lost on restart.

### Custom Provider

Add any (OpenAI-compatible) AI provider outside the built-in list.

| Method | Endpoint                                 | Description                               |
|--------|------------------------------------------|-------------------------------------------|
| `POST` | `/api/config/custom-provider`           | Create new custom provider                |
| `GET`  | `/api/config/custom-providers`          | List custom providers                     |
| `PUT`  | `/api/config/custom-provider/:provider` | Update (add model, change endpoint/key)   |
| `DELETE`| `/api/config/custom-provider/:provider`| Delete custom provider                    |

**Create a custom provider:**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"baseUrl":"https://api.example.com/v1","model":"myprovider/my-model","modelName":"My Model","apiKey":"sk-xxx"}' \
  http://localhost:9998/api/config/custom-provider
```

| Field      | Required | Description                             |
|------------|----------|-----------------------------------------|
| `baseUrl`  | Yes      | API endpoint (OpenAI-compatible)        |
| `model`    | Yes      | Format `provider/model-id`              |
| `apiKey`   | Yes      | API key                                 |
| `modelName`| No       | Display name (default = model-id)       |
| `api`      | No       | API type (default `openai-completions`) |

**Add model to an existing provider:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"another-model","modelName":"Another Model"}' \
  http://localhost:9998/api/config/custom-provider/myprovider
```

**Delete custom provider:**

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" \
  http://localhost:9998/api/config/custom-provider/myprovider
```

If deleted, and the current model belongs to this provider, the system will switch to `anthropic/claude-sonnet-4-20250514`.

### Domain and SSL

| Method | Endpoint       | Description                           |
|--------|----------------|---------------------------------------|
| `GET`  | `/api/domain` | View current domain config             |
| `PUT`  | `/api/domain` | Change domain + auto SSL               |

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"domain":"chat.example.com","email":"admin@example.com"}' \
  http://localhost:9998/api/domain
```

DNS must point to VPS IP before calling this endpoint. Caddy auto-gets Let's Encrypt cert. Auto-rollback if it fails.

### Messaging Channels

| Method | Endpoint                | Description                        |
|--------|-------------------------|------------------------------------|
| `GET`  | `/api/channels`        | List all channels and their state  |
| `PUT`  | `/api/channels/:name`  | Add/update a channel               |
| `DELETE`| `/api/channels/:name` | Remove a channel                   |

Supported channels: `telegram`, `discord`, `slack`, `zalo`

**Add a Telegram bot:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"token":"123456:ABC-xyz"}' \
  http://localhost:9998/api/channels/telegram
```

**Add Zalo OA:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"token":"your_zalo_oa_token"}' \
  http://localhost:9998/api/channels/zalo
```

API writes channel config directly to `openclaw.json` with `enabled: true`, `dmPolicy: "open"`, and `allowFrom: ["*"]`. Zalo/Discord/Slack plugins are auto-enabled.

### User Login

| Method | Endpoint                 | Description                           |
|--------|--------------------------|---------------------------------------|
| `GET`  | `/login`                | Login page (public)                   |
| `POST` | `/api/auth/login`        | Login (public) — returns gateway token|
| `POST` | `/api/auth/create-user`  | Create login account (Bearer auth required) |
| `GET`  | `/api/auth/user`         | View current account (Bearer auth)    |
| `PUT`  | `/api/auth/change-password` | Change password (Bearer auth)       |
| `DELETE`| `/api/auth/user`        | Delete login account (Bearer auth)    |

**Create account (admin only):**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}' \
  http://localhost:9998/api/auth/create-user
```

After creation, users access `https://domain/login` to log in. Credentials are verified and redirect to OpenClaw with gateway token.

### Environment Variables

| Method | Endpoint             | Description                                   |
|--------|----------------------|-----------------------------------------------|
| `GET`  | `/api/env`          | List environment variables (sensitive values hidden)|
| `PUT`  | `/api/env/:KEY`     | Set environment variable                      |
| `DELETE`| `/api/env/:KEY`    | Delete environment variable                   |

### CLI Proxy

Execute OpenClaw CLI command inside the container:

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"command":"models scan"}' \
  http://localhost:9998/api/cli
```

## Configuration

### API Key Priority Order

OpenClaw searches for API keys in this order:

1. `auth-profiles.json` — Primary (written by Management API)
2. Environment variables — Fallback (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`)

### Preserve config when switching provider

When switching providers via `PUT /api/config/provider`, the API preserves all existing configuration:

- Messaging channels (Telegram, Zalo, etc.)
- Plugins
- Gateway settings (trustedProxies, controlUi)
- Meta, messages, commands, wizard

Only the model changes.

### Gateway behind Caddy

Caddy acts as a reverse proxy. OpenClaw is configured with:

- `gateway.controlUi.allowInsecureAuth: true` — Skips device pairing when accessed via proxy
- `gateway.trustedProxies` — Docker networks (`172.16.0.0/12`, `10.0.0.0/8`, `192.168.0.0/16`)

## Docker Commands (on VPS)

```bash
cd /opt/openclaw

# View logs
docker compose logs -f

# Restart OpenClaw
docker compose restart openclaw

# Upgrade to latest version
docker compose pull && docker compose up -d

# Stop all
docker compose down

# Run CLI command
docker compose exec openclaw node dist/index.js <command>
```

## Project Structure

```
OpenClaw/
├── install.sh                  # All-in-one install script
├── docker-compose.yml          # OpenClaw + Caddy containers
├── Caddyfile                   # Caddy reverse proxy config template
├── management-api/
│   └── server.js               # Management API (port 9998)
├── config/
│   ├── anthropic.json          # Anthropic config template
│   ├── openai.json             # OpenAI config template
│   └── gemini.json             # Gemini config template
├── postman_collection.json     # API Postman collection
├── CLAUDE.md                   # AI assistant instructions
└── README.md
```

## Security Notice

- Management API uses Bearer token auth with rate limiting (10 failures = 15 minutes lockout)
- API keys are masked in all GET responses
- Gateway token is a 64-char hex string, generated by `openssl rand -hex 32`
- UFW only allows ports 80, 443, 9998, and SSH
- fail2ban active to protect against brute-force
- Never commit real API keys or tokens to git

## License

Private repository. Internal use only.
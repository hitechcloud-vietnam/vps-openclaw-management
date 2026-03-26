# CLAUDE.md - OpenClaw Docker Compose Deployment

## Project overview

System for installing and managing **OpenClaw** on VPS using Docker Compose. Includes:
- **install.sh** — All-in-one setup script (called via SSH by HostBill hook)
- **Management API** — REST API for remote management (change model, API key, domain, restart, rebuild, logs...)

## Technologies

- **Docker Compose** — Run OpenClaw + Caddy in containers
- **Node.js 22** — Management API runtime (runs on host)
- **Caddy** — Reverse proxy + automatic TLS (container)
- **UFW / fail2ban** — Firewall + brute-force protection
- **systemd** — Manage Management API service

## Directory structure

```
OpenClaw/
├── install.sh                  # All-in-one install script
├── docker-compose.yml          # Docker Compose template (openclaw + caddy)
├── Caddyfile                   # Caddy config template
├── management-api/
│   └── server.js               # Management API server (port 9998)
├── config/                     # Template configs for 18 providers
│   ├── anthropic.json openai.json gemini.json
│   ├── deepseek.json groq.json together.json mistral.json xai.json
│   ├── cerebras.json sambanova.json fireworks.json cohere.json
│   ├── yi.json baichuan.json stepfun.json siliconflow.json
│   └── novita.json openrouter.json minimax.json moonshot.json zhipu.json
├── template.json               # Packer template (legacy)
└── CLAUDE.md
```

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management/main/install.sh | bash
```

## On VPS after installation

```
/opt/openclaw/                       # Main directory
├── docker-compose.yml
├── .env                             # Environment vars (tokens, API keys)
├── Caddyfile
├── config/
│   ├── openclaw.json                # Current config
│   └── agents/                      # Per-agent auth data
│       └── <agentId>/agent/
│           └── auth-profiles.json
└── data/                            # Persistent data

/opt/openclaw-mgmt/
└── server.js                        # Management API

/etc/openclaw/config/                # Template configs (read-only)
├── anthropic.json
├── openai.json
├── gemini.json
├── deepseek.json
├── groq.json
├── together.json
├── mistral.json
├── xai.json
├── cerebras.json
├── sambanova.json
├── fireworks.json
├── cohere.json
├── yi.json
├── baichuan.json
├── stepfun.json
├── siliconflow.json
├── novita.json
├── openrouter.json
├── minimax.json
├── moonshot.json
└── zhipu.json
```

## Management API

**Port**: 9998 | **Auth**: `Authorization: Bearer <OPENCLAW_MGMT_API_KEY>`

### Endpoints

| Method | Path                             | Description                                   |
|--------|----------------------------------|-----------------------------------------------|
| `GET`  | `/api/info`                      | Service info (domain, IP, token, status)      |
| `GET`  | `/api/status`                    | Container status                              |
| `GET`  | `/api/domain`                    | View domain config                            |
| `PUT`  | `/api/domain`                    | Change domain + SSL                           |
| `GET`  | `/api/version`                   | Version + image info                          |
| `POST` | `/api/upgrade`                   | Pull new image + recreate                     |
| `POST` | `/api/restart`                   | Restart container                             |
| `POST` | `/api/stop`                      | Stop container                                |
| `POST` | `/api/start`                     | Start container                               |
| `POST` | `/api/rebuild`                   | Down + Up (recreate)                          |
| `POST` | `/api/reset`                     | Delete data, recreate from scratch            |
| `GET`  | `/api/logs`                      | Container logs                                |
| `GET`  | `/api/providers`                 | List all providers (built-in + custom)        |
| `GET`  | `/api/config`                    | View config (model, provider, keys masked)    |
| `PUT`  | `/api/config/provider`           | Change provider + model (built-in)            |
| `PUT`  | `/api/config/api-key`            | Change API key                                |
| `POST` | `/api/config/test-key`           | Test API key                                  |
| `POST` | `/api/config/custom-provider`    | Create a new custom provider                  |
| `GET`  | `/api/config/custom-providers`   | List custom providers                         |
| `PUT`  | `/api/config/custom-provider/:provider` | Update custom provider                  |
| `DELETE`| `/api/config/custom-provider/:provider` | Delete custom provider                 |
| `GET`  | `/api/channels`                  | List messaging channels                       |
| `PUT`  | `/api/channels/:ch`              | Add/update channel                            |
| `DELETE`| `/api/channels/:ch`             | Remove channel                                |
| `GET`  | `/api/env`                       | View env vars                                 |
| `PUT`  | `/api/env/:key`                  | Set env var                                   |
| `DELETE`| `/api/env/:key`                 | Delete env var                                |
| `GET`  | `/api/system`                    | System info                                   |
| `POST` | `/api/cli`                       | Proxy CLI commands to container               |
| `POST` | `/api/self-update`               | Update Management API + docker-compose + config templates from GitHub |

#### Multi-Agent Management

| Method | Path                               | Description                                   |
|--------|------------------------------------|-----------------------------------------------|
| `GET`  | `/api/agents`                      | List all agents (with key count)              |
| `POST` | `/api/agents`                      | Create a new agent                            |
| `GET`  | `/api/agents/:id`                  | Agent details (API keys masked)               |
| `PUT`  | `/api/agents/:id`                  | Update agent (name, model, workspace)         |
| `DELETE`| `/api/agents/:id`                 | Delete agent (cannot delete default/last one) |
| `PUT`  | `/api/agents/:id/default`          | Set agent as default                          |
| `GET`  | `/api/agents/:id/api-key`          | View agent's masked API keys                  |
| `PUT`  | `/api/agents/:id/api-key`          | Set API key for agent                         |

#### User Login / Authentication

| Method | Path                             | Description                                   |
|--------|----------------------------------|-----------------------------------------------|
| `GET`  | `/login`                         | Serve login page (public, no auth)            |
| `POST` | `/api/auth/login`                | Login (public) — returns gateway token        |
| `POST` | `/api/auth/create-user`          | Create login user (protected) — saved to .env |
| `GET`  | `/api/auth/user`                 | View current login user (protected)           |
| `PUT`  | `/api/auth/change-password`      | Change password (protected)                   |
| `DELETE`| `/api/auth/user`                | Delete login credentials (protected)          |

Login credentials stored in `.env`:
- `OPENCLAW_LOGIN_USER` — username
- `OPENCLAW_LOGIN_PASS` — scrypt hash (salt:hash)

Flow: User visits `domain/login` → enters username/password → POST `/api/auth/login` → receive gateway token → redirect `/#token=...`

#### Routing Bindings

| Method | Path                  | Description                      |
|--------|-----------------------|----------------------------------|
| `GET`  | `/api/bindings`       | List all routing bindings        |
| `POST` | `/api/bindings`       | Create binding (agentId + match) |
| `PUT`  | `/api/bindings/:index`| Update binding                   |
| `DELETE`| `/api/bindings/:index`| Delete binding                 |

### Usage examples

```bash
MGMT_KEY=$(grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env | cut -d= -f2)

# View status
curl -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/status

# Change model
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"anthropic/claude-sonnet-4-20250514"}' \
  http://localhost:9998/api/config/provider

# Rebuild
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/rebuild

# CLI proxy
curl -X POST -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"command":"models scan"}' http://localhost:9998/api/cli
```

### Custom Provider examples

```bash
# Create a custom provider (OpenAI-compatible endpoint)
curl -X POST -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"baseUrl":"https://api.example.com/v1","model":"myprovider/my-model","apiKey":"sk-xxx"}' \
  http://localhost:9998/api/config/custom-provider

# List custom providers
curl -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/config/custom-providers

# Update custom provider (add model, change endpoint/key)
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"model":"another-model","modelName":"Another Model"}' \
  http://localhost:9998/api/config/custom-provider/myprovider

# Delete custom provider
curl -X DELETE -H "Authorization: Bearer $MGMT_KEY" \
  http://localhost:9998/api/config/custom-provider/myprovider
```

### Multi-Agent examples

```bash
# List agents
curl -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/agents

# Create a new agent
curl -X POST -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"id":"work","name":"Work Agent","model":"anthropic/claude-sonnet-4-20250514"}' \
  http://localhost:9998/api/agents

# Set API key for agent
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","apiKey":"sk-ant-xxx"}' \
  http://localhost:9998/api/agents/work/api-key

# Set agent as default
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  http://localhost:9998/api/agents/work/default

# Create routing binding (route Telegram messages to "work" agent)
curl -X POST -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"agentId":"work","match":{"channel":"telegram"}}' \
  http://localhost:9998/api/bindings

# Delete agent
curl -X DELETE -H "Authorization: Bearer $MGMT_KEY" \
  http://localhost:9998/api/agents/work
```

## Conventions

- Docker image: `ghcr.io/openclaw/openclaw:latest`
- Gateway port: 18789 (inside Docker network, Caddy proxies to 80/443)
- Management API port: 9998 (on host, systemd)
- Tokens: 64-char hex, generated by `openssl rand -hex 32`
- Config templates stored at `/etc/openclaw/config/` (do not edit)
- Current config at `/opt/openclaw/config/openclaw.json`
- Do not commit real API keys or tokens

## Common Docker commands (on VPS)

```bash
cd /opt/openclaw
docker compose logs -f                                # View logs
docker compose restart openclaw                       # Restart
docker compose pull && docker compose up -d           # Upgrade
docker compose down                                   # Stop all
docker compose exec openclaw node dist/index.js <cmd> # CLI
```
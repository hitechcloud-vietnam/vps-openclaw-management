# Provider Config Template Guide

This document explains how `config/*.json` files work, how the Management API uses them, and how to add a new provider in the correct format.

See also:

- [`docs/provider-config-lookup.md`](docs/provider-config-lookup.md) — quick lookup table for providers, env keys, API types, base URLs and default models

## 1. Purpose of the `config/` Folder

The `config/` folder contains **configuration templates** for each provider.

Each file follows the pattern:

- `config/<provider>.json`
- e.g.: `config/openai.json`, `config/glm.json`, `config/vertex.json`

These files are used to:

1. act as templates when selecting a provider via the Management API
2. sync to VPS at `/etc/openclaw/config/*.json`
3. provide a list of default models for the UI and API
4. serve as a source for the running `openclaw.json`

## 2. Operation Flow

The Management API loads templates from:

- `/etc/openclaw/config`

In the source code, this folder is set as:

- `management-api/server.js` → `TEMPLATES_DIR = '/etc/openclaw/config'`

The usual workflow:

1. The repo stores templates at `config/*.json`
2. On update, the Management API uploads these files to the VPS
3. When calling `PUT /api/config/provider`, the system loads the corresponding template
4. The template is merged into the running config at `/opt/openclaw/config/openclaw.json`
5. OpenClaw restarts to apply the new config

## 3. Standard Structure of a Template File

A complete template should have 4 main sections:

- `agents`
- `models`
- `gateway`
- `browser`

Minimal example:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "${OPENAI_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "gpt-5", "name": "GPT 5" }
        ]
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["127.0.0.1", "::1", "172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "dangerouslyDisableDeviceAuth": false
    }
  },
  "browser": {
    "headless": true,
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
```

## 4. Explanation of Each Section

### 4.1 `agents.defaults.model.primary`

Default model when switching to this provider.

Examples:

- `openai/gpt-5`
- `glm/glm-5`
- `vertex/gemini-2.5-pro`

Recommended format: `provider/model-id`

### 4.2 `models.mode`

Should be:

- `"merge"`

This fits how `management-api/server.js` merges templates into the running config.

### 4.3 `models.providers.<provider>`

This is the most important part. The key must match the actual provider.

Examples:

- `models.providers.openai`
- `models.providers.glm`
- `models.providers.vertex`

Common fields:

| Field         | Meaning                                              |
|---------------|-----------------------------------------------------|
| `baseUrl`     | Root endpoint of the provider                       |
| `apiKey`      | Environment variable for the API key                |
| `api`         | API type used by OpenClaw                           |
| `authHeader`  | Auth header name if not `Authorization`             |
| `authPrefix`  | Auth prefix, often `Bearer`                         |
| `urlSuffix`   | Suffix to append to the URL                         |
| `headers`     | Additional static headers                           |
| `models`      | List of displayed models                            |

## 5. Common Provider Templates

### 5.1 OpenAI-Compatible

For most gateway or OpenAI-like providers.

```json
{
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "${EXAMPLE_API_KEY}",
  "api": "openai-completions",
  "models": [
    { "id": "model-a", "name": "Model A" }
  ]
}
```

Used for files like:

- `config/openrouter.json`
- `config/deepseek.json`
- `config/opencode-go.json`
- `config/opencode-zen.json`
- `config/synthetic.json`
- `config/kilo-gateway.json`
- `config/longcat.json`

### 5.2 Claude-Compatible

For providers using the Anthropic/Claude protocol.

```json
{
  "baseUrl": "https://provider.example.com/anthropic/v1/messages",
  "apiKey": "${PROVIDER_API_KEY}",
  "api": "claude",
  "authHeader": "x-api-key",
  "urlSuffix": "?beta=true",
  "headers": {
    "Anthropic-Version": "2023-06-01",
    "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
  },
  "models": [
    { "id": "model-name", "name": "Model Name" }
  ]
}
```

Used in files like:

- `config/glm.json`
- `config/zai.json`
- `config/kimi-coding-apikey.json`
- `config/minimax-cn.json`
- `config/bailian-coding-plan.json`

### 5.3 Gemini / Vertex

For Gemini-style providers:

```json
{
  "baseUrl": "https://us-central1-aiplatform.googleapis.com/v1/projects",
  "apiKey": "${VERTEX_API_KEY}",
  "api": "gemini",
  "models": [
    { "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro (Vertex)" }
  ]
}
```

Special notes for `vertex`:

- OmniRoute runtime uses a dedicated executor
- `VERTEX_API_KEY` is typically a **service account JSON** or runtime-compatible credentials
- default region is `us-central1`
- advanced options like `providerSpecificData.region` aren't shown in this repo's templates

For deeper configs, you can also use:

- `PATCH /api/config`
- `PUT /api/config/raw`

## 6. Environment Variable Naming Conventions

Each template should refer to the API key via an environment variable.

Examples:

- `OPENAI_API_KEY`
- `GLM_API_KEY`
- `VERTEX_API_KEY`
- `LONGCAT_API_KEY`
- `KILO_GATEWAY_API_KEY`

In JSON:

```json
"apiKey": "${OPENAI_API_KEY}"
```

Recommendations:

- use uppercase letters
- replace `-` with `_`
- add `_API_KEY` suffix

## 7. How to Add a New Provider (Best Practice)

### Step 1: Identify the Protocol Type

Before creating the file, determine which group the provider falls into:

- OpenAI-compatible
- Claude-compatible
- Gemini-compatible
- custom executor

Your best reference is:

- `OmniRoute/open-sse/config/providerRegistry.ts`

### Step 2: Create `config/<provider>.json`

Example:

- `config/my-provider.json`

### Step 3: Declare the Default Model

Set `agents.defaults.model.primary` to your most stable model.

Example:

- `my-provider/my-model`

### Step 4: Add `models.providers.<provider>`

The provider name in the key should match the model prefix.

Example:

- primary model: `my-provider/my-model`
- provider key: `models.providers.my-provider`

### Step 5: Leave `gateway` and `browser` Intact

Templates in this repo should use the same `gateway` and `browser` block. Do not change them unless required.

### Step 6: JSON Validation

Be sure that:

- the file is valid JSON
- `primary` matches real provider/model
- `apiKey` uses the correct environment variable
- `api` matches the right type (`openai-completions`, `claude`, `gemini`)
- the `models` list has at least one model

## 8. How the Management API Distinguishes Built-in vs Custom

### Built-in Providers

Built-ins are mapped in `management-api/server.js` via `PROVIDERS`.

When selecting a built-in provider:

- the system gets the corresponding `configTemplate`
- loads the template file
- writes to `openclaw.json`

### Custom Providers

A custom provider is a `.json` in the template directory but **not** listed in `PROVIDERS`.

For custom providers:

- the API will use the first provider under `tpl.models.providers`
- default env key format is `CUSTOM_<NAME>_API_KEY`

## 9. Template Files Added in This Batch

Recently added templates include:

- `blackbox.json`
- `perplexity.json`
- `nvidia.json`
- `nebius.json`
- `hyperbolic.json`
- `alibaba.json`
- `alicode.json`
- `alicode-intl.json`
- `scaleway.json`
- `aimlapi.json`
- `kimi.json`
- `ollama-cloud.json`
- `huggingface.json`
- `pollinations.json`
- `puter.json`
- `cloudflare-ai.json`
- `glm.json`
- `bailian-coding-plan.json`
- `zai.json`
- `kimi-coding-apikey.json`
- `minimax-cn.json`
- `opencode-go.json`
- `opencode-zen.json`
- `synthetic.json`
- `kilo-gateway.json`
- `vertex.json`
- `longcat.json`

## 10. Pre-Commit Checklist

Before finalizing, check:

- [ ] file is in `config/`
- [ ] file name matches the provider
- [ ] JSON is valid
- [ ] `primary` uses the correct provider prefix
- [ ] `models.providers` uses the right key
- [ ] `apiKey` uses a valid env variable
- [ ] `api` is correct for the protocol
- [ ] you didn't accidentally change `gateway`/`browser`
- [ ] provider is readable by the Management API from template

## 11. Related Files

- `config/*.json`
- `management-api/server.js`
- `docs/configuration.md`
- `OmniRoute/open-sse/config/providerRegistry.ts`

---

If needed, you can add a separate mapping document:

- `provider` → `env key` → `api type` → `baseUrl` → `config file`
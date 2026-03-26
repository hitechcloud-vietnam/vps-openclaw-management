# Changelog config/docs - 2026-03-26

## Scope

This update focuses on two main areas:

- completing all `config/*.json` templates based on the OmniRoute provider registry  
- adding documentation for config/template reference and usage  

---

## 1. Added Provider Config Templates

Missing config files have been added to the `config/` directory:

### Claude-compatible
- `config/glm.json`
- `config/bailian-coding-plan.json`
- `config/zai.json`
- `config/kimi-coding-apikey.json`
- `config/minimax-cn.json`

### OpenAI-compatible / Gateway-compatible
- `config/blackbox.json`
- `config/perplexity.json`
- `config/nvidia.json`
- `config/nebius.json`
- `config/hyperbolic.json`
- `config/alibaba.json`
- `config/alicode.json`
- `config/alicode-intl.json`
- `config/scaleway.json`
- `config/aimlapi.json`
- `config/kimi.json`
- `config/ollama-cloud.json`
- `config/huggingface.json`
- `config/pollinations.json`
- `config/puter.json`
- `config/cloudflare-ai.json`
- `config/opencode-go.json`
- `config/opencode-zen.json`
- `config/synthetic.json`
- `config/kilo-gateway.json`
- `config/longcat.json`

### Gemini-compatible / Custom Executor
- `config/vertex.json`

---

## 2. Documentation Updates

### New Documents

#### `docs/huong-dan-config-template.md`
- explains the role of `config/*.json`
- describes how the Management API loads templates
- provides standard template structure guidelines
- includes instructions for adding new providers

#### `docs/bang-tra-cuu-provider-config.md`
- provider → config file mapping table
- environment variable keys
- API types
- base URLs
- default models

---

### Updated Documents

#### `docs/quickstart.md`
- added links to:
  - `docs/huong-dan-config-template.md`
  - `docs/bang-tra-cuu-provider-config.md`

#### `docs/huong-dan-config-template.md`
- added reference section linking to provider lookup table

---

## 3. Installer Updates

Updated `install.sh` to:

- include new API key environment variables in the generated `.env` file  
- download all new `config/*.json` templates into `/etc/openclaw/config`  

### New Environment Variables Added

- `AIMLAPI_API_KEY`
- `ALIBABA_API_KEY`
- `ALICODE_API_KEY`
- `ALICODE_INTL_API_KEY`
- `BAILIAN_CODING_PLAN_API_KEY`
- `BLACKBOX_API_KEY`
- `CLOUDFLARE_AI_API_KEY`
- `GLM_API_KEY`
- `HUGGINGFACE_API_KEY`
- `HYPERBOLIC_API_KEY`
- `KILO_GATEWAY_API_KEY`
- `KIMI_API_KEY`
- `KIMI_CODING_API_KEY`
- `LONGCAT_API_KEY`
- `MINIMAX_CN_API_KEY`
- `NEBIUS_API_KEY`
- `NVIDIA_API_KEY`
- `OLLAMA_CLOUD_API_KEY`
- `OPENCODE_GO_API_KEY`
- `OPENCODE_ZEN_API_KEY`
- `PERPLEXITY_API_KEY`
- `POLLINATIONS_API_KEY`
- `PUTER_API_KEY`
- `SCALEWAY_API_KEY`
- `SYNTHETIC_API_KEY`
- `VERTEX_API_KEY`
- `ZAI_API_KEY`

---

## 4. Technical Notes

- Primary reference: `OmniRoute/open-sse/config/providerRegistry.ts`  
- Provider ↔ env key mapping cross-checked with `management-api/server.js`  
- `vertex` is configured as `api: "gemini"` due to custom runtime executor  
- `openai-codex` is a special provider using OAuth (not standard API key env)

---

## 5. Result

- `config/` directory is now fully covered based on current audit  
- documentation now includes both usage guide and quick reference  
- installer is synchronized with the updated provider/template list  

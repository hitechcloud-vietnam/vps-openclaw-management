# Provider Config Lookup Table

This document quickly maps each provider to its config file, environment variable, API type, endpoint, and default model.

## 1. General Notes

- Template directory: `config/`
- On VPS, Management API uses the template at: `/etc/openclaw/config`
- Files like `anthropic.json`, `openai.json`, `google.json`, `gemini.json`, `openai-codex.json` are base templates and do not directly declare `models.providers`
- `openai-codex` uses OAuth, not a traditional API Key
- `google` and `gemini` both currently use Gemini, default model is `google/gemini-2.5-pro`

## 2. Special Built-in Providers

| Provider        | Config file                    | Env Key                | API Type           | Base URL            | Default Model                        |
|-----------------|-------------------------------|------------------------|--------------------|---------------------|--------------------------------------|
| `anthropic`     | `config/anthropic.json`       | `ANTHROPIC_API_KEY`    | `claude`           | runtime built-in    | `anthropic/claude-opus-4-5`          |
| `openai`        | `config/openai.json`          | `OPENAI_API_KEY`       | `openai-completions`| runtime built-in   | `openai/gpt-5.2`                     |
| `google`        | `config/google.json`          | `GEMINI_API_KEY`       | `gemini`           | runtime built-in    | `google/gemini-2.5-pro`              |
| `gemini`        | `config/gemini.json`          | `GEMINI_API_KEY`       | `gemini`           | runtime built-in    | `google/gemini-2.5-pro`              |
| `openai-codex`  | `config/openai-codex.json`    | OAuth token            | `oauth`            | runtime built-in    | `openai-codex/gpt-5.4`               |

## 3. OpenAI-Compatible Providers

| Provider        | Config file                      | Env Key                   | API Type             | Base URL                                             | Default Model                                       |
|-----------------|----------------------------------|---------------------------|----------------------|------------------------------------------------------|-----------------------------------------------------|
| `aimlapi`       | `config/aimlapi.json`            | `AIMLAPI_API_KEY`         | `openai-completions` | `https://api.aimlapi.com/v1`                         | `aimlapi/gpt-4o`                                    |
| `alibaba`       | `config/alibaba.json`            | `ALIBABA_API_KEY`         | `openai-completions` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `alibaba/qwen-max`                            |
| `alicode`       | `config/alicode.json`            | `ALICODE_API_KEY`         | `openai-completions` | `https://coding.dashscope.aliyuncs.com/v1`           | `alicode/qwen3.5-plus`                             |
| `alicode-intl`  | `config/alicode-intl.json`       | `ALICODE_INTL_API_KEY`    | `openai-completions` | `https://coding-intl.dashscope.aliyuncs.com/v1`      | `alicode-intl/qwen3.5-plus`                        |
| `baichuan`      | `config/baichuan.json`           | `BAICHUAN_API_KEY`        | `openai-completions` | `https://api.baichuan-ai.com/v1`                     | `baichuan/Baichuan4`                               |
| `blackbox`      | `config/blackbox.json`           | `BLACKBOX_API_KEY`        | `openai-completions` | `https://api.blackbox.ai/v1`                         | `blackbox/gpt-4o`                                  |
| `cerebras`      | `config/cerebras.json`           | `CEREBRAS_API_KEY`        | `openai-completions` | `https://api.cerebras.ai/v1`                         | `cerebras/llama-3.3-70b`                           |
| `cloudflare-ai` | `config/cloudflare-ai.json`      | `CLOUDFLARE_AI_API_KEY`   | `openai-completions` | `https://api.cloudflare.com/client/v4/accounts`      | `cloudflare-ai/@cf/meta/llama-3.3-70b-instruct`     |
| `cohere`        | `config/cohere.json`             | `COHERE_API_KEY`          | `openai-completions` | `https://api.cohere.ai/compatibility/v1`             | `cohere/command-r-plus`                            |
| `deepseek`      | `config/deepseek.json`           | `DEEPSEEK_API_KEY`        | `openai-completions` | `https://api.deepseek.com/v1`                        | `deepseek/deepseek-chat`                           |
| `fireworks`     | `config/fireworks.json`          | `FIREWORKS_API_KEY`       | `openai-completions` | `https://api.fireworks.ai/inference/v1`              | `fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct` |
| `groq`          | `config/groq.json`               | `GROQ_API_KEY`            | `openai-completions` | `https://api.groq.com/openai/v1`                     | `groq/llama-3.3-70b-versatile`                     |
| `huggingface`   | `config/huggingface.json`        | `HUGGINGFACE_API_KEY`     | `openai-completions` | `https://router.huggingface.co/hf-inference/models/meta-llama/Meta-Llama-3.1-70B-Instruct/v1` | `huggingface/meta-llama/Meta-Llama-3.1-70B-Instruct` |
| `hyperbolic`    | `config/hyperbolic.json`         | `HYPERBOLIC_API_KEY`      | `openai-completions` | `https://api.hyperbolic.xyz/v1`                      | `hyperbolic/Qwen/QwQ-32B`                          |
| `kilo-gateway`  | `config/kilo-gateway.json`       | `KILO_GATEWAY_API_KEY`    | `openai-completions` | `https://api.kilo.ai/api/gateway`                    | `kilo-gateway/kilo-auto/frontier`                  |
| `kimi`          | `config/kimi.json`               | `KIMI_API_KEY`            | `openai-completions` | `https://api.moonshot.ai/v1`                         | `kimi/kimi-k2.5`                                   |
| `longcat`       | `config/longcat.json`            | `LONGCAT_API_KEY`         | `openai-completions` | `https://api.longcat.chat/openai/v1`                 | `longcat/LongCat-Flash-Lite`                       |
| `minimax`       | `config/minimax.json`            | `MINIMAX_API_KEY`         | `openai-completions` | `https://api.minimax.io/v1`                          | `minimax/MiniMax-M2.5`                             |
| `mistral`       | `config/mistral.json`            | `MISTRAL_API_KEY`         | `openai-completions` | `https://api.mistral.ai/v1`                          | `mistral/mistral-large-latest`                     |
| `moonshot`      | `config/moonshot.json`           | `MOONSHOT_API_KEY`        | `openai-completions` | `https://api.moonshot.ai/v1`                         | `moonshot/kimi-k2.5`                               |
| `nebius`        | `config/nebius.json`             | `NEBIUS_API_KEY`          | `openai-completions` | `https://api.tokenfactory.nebius.com/v1`             | `nebius/meta-llama/Llama-3.3-70B-Instruct`          |
| `novita`        | `config/novita.json`             | `NOVITA_API_KEY`          | `openai-completions` | `https://api.novita.ai/v3/openai`                    | `novita/deepseek/deepseek-r1`                      |
| `nvidia`        | `config/nvidia.json`             | `NVIDIA_API_KEY`          | `openai-completions` | `https://integrate.api.nvidia.com/v1`                | `nvidia/gpt-oss-120b`                              |
| `ollama-cloud`  | `config/ollama-cloud.json`       | `OLLAMA_CLOUD_API_KEY`    | `openai-completions` | `https://api.ollama.com/v1`                          | `ollama-cloud/gemma3:27b`                           |
| `opencode-go`   | `config/opencode-go.json`        | `OPENCODE_GO_API_KEY`     | `openai-completions` | `https://opencode.ai/zen/go/v1`                      | `opencode-go/glm-5`                                |
| `opencode-zen`  | `config/opencode-zen.json`       | `OPENCODE_ZEN_API_KEY`    | `openai-completions` | `https://opencode.ai/zen/v1`                         | `opencode-zen/minimax-m2.5-free`                   |
| `openrouter`    | `config/openrouter.json`         | `OPENROUTER_API_KEY`      | `openai-completions` | `https://openrouter.ai/api/v1`                       | `openrouter/deepseek/deepseek-chat`                |
| `perplexity`    | `config/perplexity.json`         | `PERPLEXITY_API_KEY`      | `openai-completions` | `https://api.perplexity.ai`                          | `perplexity/sonar-pro`                             |
| `pollinations`  | `config/pollinations.json`       | `POLLINATIONS_API_KEY`    | `openai-completions` | `https://text.pollinations.ai/openai`                | `pollinations/openai`                              |
| `puter`         | `config/puter.json`              | `PUTER_API_KEY`           | `openai-completions` | `https://api.puter.com/puterai/openai/v1`            | `puter/gpt-4o-mini`                                |
| `sambanova`     | `config/sambanova.json`          | `SAMBANOVA_API_KEY`       | `openai-completions` | `https://api.sambanova.ai/v1`                        | `sambanova/Meta-Llama-3.3-70B-Instruct`            |
| `scaleway`      | `config/scaleway.json`           | `SCALEWAY_API_KEY`        | `openai-completions` | `https://api.scaleway.ai/v1`                         | `scaleway/qwen3-235b-a22b-instruct-2507`           |
| `siliconflow`   | `config/siliconflow.json`        | `SILICONFLOW_API_KEY`     | `openai-completions` | `https://api.siliconflow.com/v1`                     | `siliconflow/deepseek-ai/DeepSeek-V3`              |
| `stepfun`       | `config/stepfun.json`            | `STEPFUN_API_KEY`         | `openai-completions` | `https://api.stepfun.com/v1`                         | `stepfun/step-2-16k`                               |
| `synthetic`     | `config/synthetic.json`          | `SYNTHETIC_API_KEY`       | `openai-completions` | `https://api.synthetic.new/openai/v1`                | `synthetic/gpt-5`                                  |
| `together`      | `config/together.json`           | `TOGETHER_API_KEY`        | `openai-completions` | `https://api.together.xyz/v1`                        | `together/meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `xai`           | `config/xai.json`                | `XAI_API_KEY`             | `openai-completions` | `https://api.x.ai/v1`                                | `xai/grok-3-latest`                                |
| `yi`            | `config/yi.json`                 | `YI_API_KEY`              | `openai-completions` | `https://api.01.ai/v1`                               | `yi/yi-lightning`                                  |
| `zhipu`         | `config/zhipu.json`              | `ZHIPU_API_KEY`           | `openai-completions` | `https://open.bigmodel.cn/api/paas/v4`               | `zhipu/glm-4.5-flash`                              |

## 4. Claude-Compatible Providers

| Provider               | Config file                          | Env Key                      | API Type     | Base URL                                                             | Default Model                         |
|------------------------|--------------------------------------|------------------------------|--------------|----------------------------------------------------------------------|--------------------------------------|
| `bailian-coding-plan`  | `config/bailian-coding-plan.json`    | `BAILIAN_CODING_PLAN_API_KEY`| `claude`     | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic/v1/messages` | `bailian-coding-plan/qwen3.5-plus`   |
| `glm`                  | `config/glm.json`                    | `GLM_API_KEY`                | `claude`     | `https://api.z.ai/api/anthropic/v1/messages`                         | `glm/glm-5`                          |
| `kimi-coding-apikey`   | `config/kimi-coding-apikey.json`     | `KIMI_CODING_API_KEY`        | `claude`     | `https://api.kimi.com/coding/v1/messages`                            | `kimi-coding-apikey/kimi-k2.5`       |
| `minimax-cn`           | `config/minimax-cn.json`             | `MINIMAX_CN_API_KEY`         | `claude`     | `https://api.minimaxi.com/anthropic/v1/messages`                     | `minimax-cn/minimax-m2.7`            |
| `zai`                  | `config/zai.json`                    | `ZAI_API_KEY`                | `claude`     | `https://api.z.ai/api/anthropic/v1/messages`                         | `zai/glm-5`                          |

## 5. Gemini-Compatible / Dedicated Executor Providers

| Provider   | Config file           | Env Key          | API Type  | Base URL                                                      | Default Model                |
|------------|----------------------|------------------|-----------|---------------------------------------------------------------|------------------------------|
| `vertex`   | `config/vertex.json` | `VERTEX_API_KEY` | `gemini`  | `https://us-central1-aiplatform.googleapis.com/v1/projects`   | `vertex/gemini-2.5-pro`      |

## 6. Usage Notes

### Providers without `models.providers` in Config File

These files are mainly base templates:

- `config/anthropic.json`
- `config/openai.json`
- `config/google.json`
- `config/gemini.json`
- `config/openai-codex.json`

These providers are still registered as built-ins in `management-api/server.js`, and model/metadata will be added at runtime or from `PROVIDERS`.

### `openai-codex`

- Uses OAuth instead of regular API Keys
- Not mapped via `PUT /api/config/api-key` like API key providers
- The template file is still used for selecting the default provider/model

### `vertex`

- `VERTEX_API_KEY` is usually a service account credential matching the runtime
- OmniRoute executor will build the real URL from the project and region
- For further configuration, use `PATCH /api/config` or `PUT /api/config/raw`

## 7. Related Files

- `docs/huong-dan-config-template.md`
- `config/*.json`
- `management-api/server.js`
- `OmniRoute/open-sse/config/providerRegistry.ts`
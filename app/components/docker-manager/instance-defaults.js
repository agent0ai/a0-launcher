const CHAT_MODEL_PROVIDER_OPTIONS = Object.freeze([
  Object.freeze(["a0_venice", "Agent Zero API"]),
  Object.freeze(["openrouter", "OpenRouter"]),
  Object.freeze(["anthropic", "Anthropic"]),
  Object.freeze(["openai", "OpenAI"]),
  Object.freeze(["google", "Google Gemini"]),
  Object.freeze(["xai", "xAI"]),
  Object.freeze(["groq", "Groq"]),
  Object.freeze(["mistral", "Mistral"]),
  Object.freeze(["deepseek", "DeepSeek"]),
  Object.freeze(["moonshot", "Moonshot AI"]),
  Object.freeze(["nebius", "Nebius Token Factory"]),
  Object.freeze(["sambanova", "Sambanova"]),
  Object.freeze(["venice", "Venice.ai"]),
  Object.freeze(["zai", "Z.AI"]),
  Object.freeze(["zai_coding", "Z.AI Coding"]),
  Object.freeze(["github_copilot", "GitHub Copilot"]),
  Object.freeze(["cometapi", "CometAPI"]),
  Object.freeze(["ollama", "Ollama"]),
  Object.freeze(["ollama_cloud", "Ollama Cloud"]),
  Object.freeze(["lm_studio", "LM Studio"]),
  Object.freeze(["llama_cpp", "llama.cpp"]),
  Object.freeze(["omlx", "oMLX"]),
  Object.freeze(["vllm", "vLLM"]),
  Object.freeze(["huggingface", "Hugging Face"]),
  Object.freeze(["azure", "OpenAI Azure"]),
  Object.freeze(["bedrock", "AWS Bedrock"]),
  Object.freeze(["other", "Other"])
]);

const EMBEDDING_MODEL_PROVIDER_OPTIONS = Object.freeze([
  Object.freeze(["huggingface", "Hugging Face"]),
  Object.freeze(["openai", "OpenAI"]),
  Object.freeze(["openrouter", "OpenRouter"]),
  Object.freeze(["google", "Google Gemini"]),
  Object.freeze(["mistral", "Mistral"]),
  Object.freeze(["a0_venice", "Agent Zero API"]),
  Object.freeze(["venice", "Venice.ai"]),
  Object.freeze(["ollama", "Ollama"]),
  Object.freeze(["lm_studio", "LM Studio"]),
  Object.freeze(["llama_cpp", "llama.cpp"]),
  Object.freeze(["omlx", "oMLX"]),
  Object.freeze(["vllm", "vLLM"]),
  Object.freeze(["azure", "OpenAI Azure"]),
  Object.freeze(["bedrock", "AWS Bedrock"]),
  Object.freeze(["other", "Other"])
]);

const PRIMARY_INSTANCE_MODEL_SLOTS = Object.freeze([
  Object.freeze({
    id: "Main",
    label: "Main",
    defaultProvider: "openrouter",
    providerEnv: "A0_SET__model_config__chat_model__provider",
    modelEnv: "A0_SET__model_config__chat_model__name",
    modelPlaceholder: "anthropic/claude-sonnet-4.6",
    keyPlaceholder: "OpenRouter API key",
    providerOptions: CHAT_MODEL_PROVIDER_OPTIONS
  }),
  Object.freeze({
    id: "Utility",
    label: "Utility",
    defaultProvider: "openrouter",
    providerEnv: "A0_SET__model_config__utility_model__provider",
    modelEnv: "A0_SET__model_config__utility_model__name",
    modelPlaceholder: "google/gemini-3.1-flash-lite-preview",
    keyPlaceholder: "OpenRouter API key",
    providerOptions: CHAT_MODEL_PROVIDER_OPTIONS
  })
]);

const ADVANCED_INSTANCE_MODEL_SLOTS = Object.freeze([
  Object.freeze({
    id: "Embedding",
    label: "Embedding",
    defaultProvider: "huggingface",
    providerEnv: "A0_SET__model_config__embedding_model__provider",
    modelEnv: "A0_SET__model_config__embedding_model__name",
    modelPlaceholder: "sentence-transformers/all-MiniLM-L6-v2",
    keyPlaceholder: "Embedding API key",
    providerOptions: EMBEDDING_MODEL_PROVIDER_OPTIONS
  })
]);

const INSTANCE_MODEL_SLOTS = Object.freeze([
  ...PRIMARY_INSTANCE_MODEL_SLOTS,
  ...ADVANCED_INSTANCE_MODEL_SLOTS
]);

function sanitizeName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned || "agent-zero";
}

function defaultInstanceName(tag, state = {}) {
  const base = sanitizeName(`agent-zero-${tag || "instance"}`).slice(0, 64);
  const containers = Array.isArray(state?.containers) ? state.containers : [];
  const used = new Set(containers.map((container) =>
    String(container?.instanceName || container?.containerName || "").trim()
  ).filter(Boolean));
  if (!used.has(base)) return base;

  for (let i = 2; i < 100; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }

  const suffix = `-${Date.now().toString(36).slice(-6)}`;
  return `${base.slice(0, 64 - suffix.length)}${suffix}`;
}

function cleanText(value, maxLength = 512) {
  return String(value || "")
    .trim()
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, maxLength);
}

function defaultInstanceDefaults() {
  const models = {};
  for (const slot of INSTANCE_MODEL_SLOTS) {
    models[slot.id] = {
      provider: slot.defaultProvider,
      model: "",
      apiKey: ""
    };
  }
  return { models };
}

function normalizeInstanceDefaults(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const sourceModels = source.models && typeof source.models === "object" ? source.models : {};
  const fallback = defaultInstanceDefaults();
  const models = {};

  for (const slot of INSTANCE_MODEL_SLOTS) {
    const entry = sourceModels[slot.id] && typeof sourceModels[slot.id] === "object" ? sourceModels[slot.id] : {};
    models[slot.id] = {
      provider: cleanText(entry.provider, 96) || fallback.models[slot.id].provider,
      model: cleanText(entry.model, 256),
      apiKey: cleanText(entry.apiKey, 4096)
    };
  }

  return { models };
}

function providerOptionsHtml(options, selectedValue = "") {
  return options
    .map(([value, label]) => `<option value="${value}"${value === selectedValue ? " selected" : ""}>${label}</option>`)
    .join("");
}

function slotFieldId(prefix, slotId, field) {
  return `${prefix}${slotId}${field}`;
}

function instanceModelRowsHtml(slots, defaults = null, prefix = "activate") {
  const normalized = normalizeInstanceDefaults(defaults);
  return slots.map((slot) => {
    const entry = normalized.models[slot.id] || {};
    const providerId = slotFieldId(prefix, slot.id, "Provider");
    const modelId = slotFieldId(prefix, slot.id, "Model");
    const apiKeyId = slotFieldId(prefix, slot.id, "ApiKey");
    const provider = entry.provider || slot.defaultProvider;
    const model = entry.model || "";
    const apiKey = entry.apiKey || "";
    return `
      <div class="dm-model-section">
        <div class="dm-model-label">${slot.label}</div>
        <div class="dm-model-controls">
          <div class="dm-model-row">
            <select id="${providerId}" class="dm-select" aria-label="${slot.label} provider">
              ${providerOptionsHtml(slot.providerOptions, provider)}
            </select>
            <input id="${modelId}" class="dm-text-input" type="text" autocomplete="off" aria-label="${slot.label} model" placeholder="${slot.modelPlaceholder}" value="${escapeAttribute(model)}">
          </div>
          <input id="${apiKeyId}" class="dm-text-input dm-model-api-key" type="password" autocomplete="off" aria-label="${slot.label} API key" placeholder="${slot.keyPlaceholder}" value="${escapeAttribute(apiKey)}">
        </div>
      </div>
    `;
  }).join("");
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fieldValue(root, selector) {
  return String(root?.querySelector?.(selector)?.value || "").trim();
}

function applyInstanceDefaultsToForm(root, prefix, defaults, options = {}) {
  const normalized = normalizeInstanceDefaults(defaults);
  const respectDirty = options?.respectDirty === true;
  for (const slot of INSTANCE_MODEL_SLOTS) {
    const entry = normalized.models[slot.id] || {};
    const provider = root?.querySelector?.(`#${slotFieldId(prefix, slot.id, "Provider")}`);
    const model = root?.querySelector?.(`#${slotFieldId(prefix, slot.id, "Model")}`);
    const apiKey = root?.querySelector?.(`#${slotFieldId(prefix, slot.id, "ApiKey")}`);

    if (provider && (!respectDirty || !provider.dataset.dirty)) provider.value = entry.provider || slot.defaultProvider;
    if (model && (!respectDirty || !model.dataset.dirty)) model.value = entry.model || "";
    if (apiKey && (!respectDirty || !apiKey.dataset.dirty)) apiKey.value = entry.apiKey || "";
  }
}

function readInstanceDefaultsFromForm(root, prefix) {
  const models = {};
  for (const slot of INSTANCE_MODEL_SLOTS) {
    models[slot.id] = {
      provider: fieldValue(root, `#${slotFieldId(prefix, slot.id, "Provider")}`) || slot.defaultProvider,
      model: fieldValue(root, `#${slotFieldId(prefix, slot.id, "Model")}`),
      apiKey: fieldValue(root, `#${slotFieldId(prefix, slot.id, "ApiKey")}`)
    };
  }
  return normalizeInstanceDefaults({ models });
}

function bindInstanceDefaultDirtyTracking(root, prefix) {
  for (const slot of INSTANCE_MODEL_SLOTS) {
    for (const field of ["Provider", "Model", "ApiKey"]) {
      const el = root?.querySelector?.(`#${slotFieldId(prefix, slot.id, field)}`);
      if (!el || el.dataset.boundDirty) continue;
      el.dataset.boundDirty = "1";
      const eventName = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(eventName, () => { el.dataset.dirty = "1"; });
    }
  }
}

function clearInstanceDefaultDirty(root, prefix) {
  for (const slot of INSTANCE_MODEL_SLOTS) {
    for (const field of ["Provider", "Model", "ApiKey"]) {
      const el = root?.querySelector?.(`#${slotFieldId(prefix, slot.id, field)}`);
      if (el) delete el.dataset.dirty;
    }
  }
}

function envKeyFromLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return "";
  const idx = trimmed.indexOf("=");
  return idx > 0 ? trimmed.slice(0, idx).trim() : "";
}

function providerApiKeyName(provider) {
  const suffix = String(provider || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  return suffix ? `API_KEY_${suffix}` : "";
}

function mergeEnvText(generatedLines, userText) {
  const userLines = String(userText || "").split(/\r?\n/);
  const userKeys = new Set(userLines.map(envKeyFromLine).filter(Boolean));
  const generated = generatedLines.filter((line) => !userKeys.has(envKeyFromLine(line)));
  const userBlock = userLines.join("\n").trim();
  if (!generated.length) return userBlock;
  if (!userBlock) return generated.join("\n");
  return `${generated.join("\n")}\n\n${userBlock}`;
}

function buildInstanceEnvText(instanceDefaults, userText = "") {
  const defaults = normalizeInstanceDefaults(instanceDefaults);
  const lines = [];
  const apiKeys = new Map();

  for (const slot of INSTANCE_MODEL_SLOTS) {
    const entry = defaults.models[slot.id] || {};
    const provider = cleanText(entry.provider, 96) || slot.defaultProvider || "";
    const model = cleanText(entry.model, 256);
    const apiKey = cleanText(entry.apiKey, 4096);
    if (provider && (provider !== slot.defaultProvider || model || apiKey)) {
      lines.push(`${slot.providerEnv}=${provider}`);
    }
    if (model) lines.push(`${slot.modelEnv}=${model}`);

    if (apiKey) {
      const apiKeyName = providerApiKeyName(provider);
      if (!apiKeyName) {
        return { ok: false, message: `Choose the provider for the ${slot.label} API key.` };
      }
      const existing = apiKeys.get(apiKeyName);
      if (existing && existing !== apiKey) {
        return { ok: false, message: `Use one ${provider} API key across model slots, or choose separate providers.` };
      }
      apiKeys.set(apiKeyName, apiKey);
    }
  }

  for (const [key, value] of apiKeys) lines.push(`${key}=${value}`);

  return { ok: true, value: mergeEnvText(lines, userText) };
}

function buildInstanceEnvTextFromForm(root, prefix, userText = "") {
  return buildInstanceEnvText(readInstanceDefaultsFromForm(root, prefix), userText);
}

export {
  ADVANCED_INSTANCE_MODEL_SLOTS,
  INSTANCE_MODEL_SLOTS,
  PRIMARY_INSTANCE_MODEL_SLOTS,
  applyInstanceDefaultsToForm,
  bindInstanceDefaultDirtyTracking,
  buildInstanceEnvText,
  buildInstanceEnvTextFromForm,
  clearInstanceDefaultDirty,
  defaultInstanceDefaults,
  defaultInstanceName,
  instanceModelRowsHtml,
  normalizeInstanceDefaults,
  readInstanceDefaultsFromForm
};

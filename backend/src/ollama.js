import "dotenv/config";

const BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || "phi3:mini";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

// Feature flag: set DISABLE_OLLAMA=1 to disable any external LLM calls
const DISABLE_OLLAMA = String(process.env.DISABLE_OLLAMA || "").trim() === "1";

const COMMAND_ONLY_FALLBACK_MESSAGE =
  "I did not recognize that as a supported command. Please re-enter using one of the supported commands (type: help).";

/**
 * Demo-friendly defaults (CPU):
 * - Keep responses short and stable
 * - Reduce latency
 */
function getChatOptions({ fast = false } = {}) {
  // Allow overriding via env (strings -> numbers)
  const envTemp = process.env.OLLAMA_TEMPERATURE;
  const envPredict = process.env.OLLAMA_NUM_PREDICT;

  // Two presets: fast commands vs normal answers
  const preset = fast
    ? { temperature: 0.1, num_predict: 90 }
    : { temperature: 0.2, num_predict: 180 };

  const temperature = Number.isFinite(Number(envTemp)) ? Number(envTemp) : preset.temperature;
  const num_predict = Number.isFinite(Number(envPredict)) ? Number(envPredict) : preset.num_predict;

  // Safe defaults.
  return {
    temperature,
    num_predict,
    top_p: 0.9,
    top_k: 40,
    repeat_penalty: 1.1,
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

/**
 * Chat call.
 * When DISABLE_OLLAMA=1, returns a deterministic fallback message and does not call Ollama.
 */
export async function ollamaChat(messages, { fast = false } = {}) {
  if (DISABLE_OLLAMA) {
    return COMMAND_ONLY_FALLBACK_MESSAGE;
  }

  const data = await postJson(`${BASE_URL}/api/chat`, {
    model: CHAT_MODEL,
    messages,
    stream: false,
    options: getChatOptions({ fast }),
  });

  return data?.message?.content || "";
}

/**
 * Embedding call.
 * When DISABLE_OLLAMA=1, returns [] (no embedding) and does not call Ollama.
 */
export async function ollamaEmbed(text) {
  if (DISABLE_OLLAMA) {
    return [];
  }

  const data = await postJson(`${BASE_URL}/api/embeddings`, {
    model: EMBED_MODEL,
    prompt: text,
  });
  return data?.embedding || [];
}

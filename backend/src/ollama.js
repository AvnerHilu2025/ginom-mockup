import "dotenv/config";

const BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || "phi3:mini";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

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

  // You can tune these later; they’re safe defaults.
  return {
    temperature,
    num_predict,
    top_p: 0.9,
    top_k: 40,
    repeat_penalty: 1.1
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
 * You can pass { fast: true } for command-like prompts to reduce latency.
 */
export async function ollamaChat(messages, { fast = false } = {}) {
  const data = await postJson(`${BASE_URL}/api/chat`, {
    model: CHAT_MODEL,
    messages,
    stream: false,
    options: getChatOptions({ fast }),
  });

  return data?.message?.content || "";
}

export async function ollamaEmbed(text) {
  const data = await postJson(`${BASE_URL}/api/embeddings`, {
    model: EMBED_MODEL,
    prompt: text,
  });
  return data?.embedding || [];
}

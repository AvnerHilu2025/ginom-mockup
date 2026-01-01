import "dotenv/config";
import { all } from "./db.js";
import { ollamaEmbed } from "./ollama.js";

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function ragSearch(db, query) {
  const enabled = String(process.env.RAG_ENABLED || "true") === "true";
  if (!enabled) return [];

  const topK = Number(process.env.RAG_TOPK || 4);
  const qEmb = await ollamaEmbed(query);

  const chunks = await all(db, "SELECT content, embedding_json FROM doc_chunks");
  if (!chunks.length) return [];

  const scored = chunks.map(c => {
    const emb = JSON.parse(c.embedding_json);
    return { content: c.content, score: cosine(qEmb, emb) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(x => x.score > 0.2).map(x => x.content);
}

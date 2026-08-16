// NEW: Local browser embeddings. The model is downloaded and cached by the browser;
// no API key or application backend is involved.
let embedder = null;
let pipelineFactory = null;

export async function getEmbedder() {
  if (!embedder) {
    // Dynamic loading keeps the studio functional in keyword mode if the CDN or
    // first-time model download is unavailable.
    if (!pipelineFactory) {
      ({ pipeline: pipelineFactory } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2'));
    }
    embedder = await pipelineFactory('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

export async function embedText(text) {
  const model = await getEmbedder();
  const output = await model(String(text || ''), { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

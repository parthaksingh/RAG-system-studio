import { cosineSimilarity, embedText } from './embedder.js';

// NEW: Keyword retrieval remains the resilient fallback while embeddings load.
function scoreChunk(chunk, question) {
  const questionWords = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3);

  // Existing manual cards use `content`; uploaded cards also provide `text`.
  const chunkText = String(chunk.text || chunk.content || '').toLowerCase();
  let score = 0;

  questionWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'g');
    const matches = (chunkText.match(regex) || []).length;
    score += matches * 2;
    if (chunkText.includes(word)) score += 1;
  });

  return score;
}

function keywordSearch(chunks, question, topN) {
  if (!chunks || chunks.length === 0) return { chunks: [], mode: 'keyword', relevance: null };
  if (chunks.length <= topN) return { chunks, mode: 'keyword', relevance: null };

  return {
    chunks: chunks
    .map(chunk => ({ ...chunk, score: scoreChunk(chunk, question) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    // Score is retrieval-only metadata and is never sent as document context.
    .map(({ score, ...chunk }) => chunk),
    mode: 'keyword',
    relevance: null
  };
}

// NEW: Semantic retrieval uses locally generated MiniLM embeddings when ready.
export async function getTopChunks(chunks, question, topN = 3) {
  if (!chunks || chunks.length === 0) return { chunks: [], mode: 'keyword', relevance: null };
  if (!chunks.some(chunk => Array.isArray(chunk.embedding))) return keywordSearch(chunks, question, topN);

  try {
    const questionEmbedding = await embedText(question);
    const scored = chunks
      .map(chunk => ({ ...chunk, score: Array.isArray(chunk.embedding) ? cosineSimilarity(questionEmbedding, chunk.embedding) : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    const semanticScores = scored.filter(chunk => Array.isArray(chunk.embedding)).map(chunk => chunk.score);
    return {
      chunks: scored.map(({ score, ...chunk }) => chunk),
      mode: 'semantic',
      relevance: semanticScores.length ? semanticScores.reduce((sum, score) => sum + score, 0) / semanticScores.length : null
    };
  } catch (error) {
    console.warn('Semantic retrieval unavailable; using keyword fallback.', error);
    return keywordSearch(chunks, question, topN);
  }
}

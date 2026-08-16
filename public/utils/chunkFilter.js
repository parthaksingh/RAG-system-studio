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

  const broadQuery = isBroadQuery(question);
  const effectiveTopN = broadQuery ? Math.max(topN, 12) : topN;
  const scored = chunks
    .map(chunk => ({ ...chunk, score: scoreChunk(chunk, question) }))
    .sort((a, b) => b.score - a.score);
  return {
    chunks: selectChunks(scored, effectiveTopN, broadQuery)
    // Score is retrieval-only metadata and is never sent as document context.
    .map(({ score, ...chunk }) => chunk),
    mode: broadQuery ? 'keyword-broad' : 'keyword',
    relevance: null
  };
}

const BROAD_QUERY_PATTERN = /\b(main topics?|overview|summary|summari[sz]e|what does (?:this|the document) cover|syllabus|outline|key (?:themes?|points?)|broadly|in general)\b/i;

// Focused fact questions deliberately stay on the existing small top-k path.
function isBroadQuery(question) {
  return BROAD_QUERY_PATTERN.test(question || '');
}

function clusterKey(chunk, index) {
  const source = chunk.source || 'document';
  const location = chunk.pageNumber ?? chunk.page ?? chunk.section ?? `chunk-${index}`;
  return `${source}|${location}`;
}

// Broad answers need coverage, not several near-duplicate chunks from one page.
function selectChunks(scoredChunks, limit, diversify) {
  if (!diversify) return scoredChunks.slice(0, limit);

  const selected = [];
  const seenClusters = new Set();
  scoredChunks.forEach((chunk, index) => {
    const key = clusterKey(chunk, index);
    if (!seenClusters.has(key) && selected.length < limit) {
      seenClusters.add(key);
      selected.push(chunk);
    }
  });
  // If there are fewer pages/sections than the requested context size, retain
  // the next-best chunks while keeping every original metadata field intact.
  for (const chunk of scoredChunks) {
    if (selected.length >= limit) break;
    if (!selected.includes(chunk)) selected.push(chunk);
  }
  return selected;
}

// NEW: Semantic retrieval uses locally generated MiniLM embeddings when ready.
export async function getTopChunks(chunks, question, topN = 3) {
  if (!chunks || chunks.length === 0) return { chunks: [], mode: 'keyword', relevance: null };
  if (!chunks.some(chunk => Array.isArray(chunk.embedding))) return keywordSearch(chunks, question, topN);

  try {
    const questionEmbedding = await embedText(question);
    const broadQuery = isBroadQuery(question);
    const effectiveTopN = broadQuery ? Math.max(topN, 12) : topN;
    const scored = chunks
      .map(chunk => ({ ...chunk, score: Array.isArray(chunk.embedding) ? cosineSimilarity(questionEmbedding, chunk.embedding) : 0 }))
      .sort((a, b) => b.score - a.score);
    const selected = selectChunks(scored, effectiveTopN, broadQuery);
    const semanticScores = selected.filter(chunk => Array.isArray(chunk.embedding)).map(chunk => chunk.score);
    return {
      chunks: selected.map(({ score, ...chunk }) => chunk),
      mode: broadQuery ? 'semantic-broad' : 'semantic',
      relevance: semanticScores.length ? semanticScores.reduce((sum, score) => sum + score, 0) / semanticScores.length : null
    };
  } catch (error) {
    console.warn('Semantic retrieval unavailable; using keyword fallback.', error);
    return keywordSearch(chunks, question, topN);
  }
}

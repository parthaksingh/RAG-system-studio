import { getTopChunks } from './utils/chunkFilter.js';

let currentMode = 'universal';
let presets = {};
// NEW: Browser-only state for semantic vectors, chat continuity, and evaluation.
const chunkEmbeddings = new Map();
let conversationHistory = [];
const evaluationMetrics = { totalQueries: 0, relevanceTotal: 0, relevanceCount: 0, answerTokensTotal: 0, citedCount: 0, refusalCount: 0, chunksTotal: 0, queryHistory: [] };

// DOM Elements
const tabButtons = document.querySelectorAll('.tab-btn');
const modeBadge = document.getElementById('modeBadge');
const chunksList = document.getElementById('chunksList');
const btnAddChunk = document.getElementById('btnAddChunk');
const btnUploadDoc = document.getElementById('btnUploadDoc');
const fileUploadInput = document.getElementById('fileUploadInput');
const uploadBtnText = document.getElementById('uploadBtnText');
const uploadStatusBanner = document.getElementById('uploadStatusBanner');
const btnLoadPreset = document.getElementById('btnLoadPreset');
const btnClearChunks = document.getElementById('btnClearChunks');
const userQuestionInput = document.getElementById('userQuestion');
const btnExecuteQuery = document.getElementById('btnExecuteQuery');

const tabAnsView = document.getElementById('tabAnsView');
const tabPromptView = document.getElementById('tabPromptView');
const tabApiCodeView = document.getElementById('tabApiCodeView');
const viewAnswer = document.getElementById('viewAnswer');
const viewPrompt = document.getElementById('viewPrompt');
const viewApiCode = document.getElementById('viewApiCode');

const answerContainer = document.getElementById('answerContainer');
const responseStatusBadge = document.getElementById('responseStatusBadge');
const promptCodePreview = document.getElementById('promptCodePreview');
const apiCodeContent = document.getElementById('apiCodeContent');
const btnCopyPrompt = document.getElementById('btnCopyPrompt');
const btnCopyApiCode = document.getElementById('btnCopyApiCode');
const btnClearConversation = document.getElementById('btnClearConversation');
const conversationHistoryEl = document.getElementById('conversationHistory');
const tabEvaluationView = document.getElementById('tabEvaluationView');
const viewEvaluation = document.getElementById('viewEvaluation');
const evaluationMetricsEl = document.getElementById('evaluationMetrics');
const evaluationHistoryEl = document.getElementById('evaluationHistory');
const btnExportEvaluation = document.getElementById('btnExportEvaluation');

// Load Presets from server
async function initPresets() {
  try {
    const res = await fetch('/api/presets');
    presets = await res.json();
    // Presets are available on demand only; startup must not overwrite user chunks.
    updateLivePrompt();
  } catch (err) {
    console.error('Failed to load presets:', err);
  }
}

// Render Chunk Elements
function createChunkElement(chunk = { source: '', page: '', content: '' }) {
  const card = document.createElement('div');
  card.className = 'chunk-card';
  // NEW: Preserve upload metadata without changing the established editable-card UI.
  if (chunk.fileType) card.dataset.fileType = chunk.fileType;
  if (chunk.pageNumber !== undefined) card.dataset.pageNumber = String(chunk.pageNumber);
  if (chunk.chunkIndex !== undefined) card.dataset.chunkIndex = String(chunk.chunkIndex);

  const header = document.createElement('div');
  header.className = 'chunk-header-inputs';
  const sourceInput = document.createElement('input');
  sourceInput.type = 'text';
  sourceInput.className = 'chunk-source';
  sourceInput.placeholder = 'Source (e.g. policy.pdf)';
  sourceInput.value = chunk.source || '';
  const pageInput = document.createElement('input');
  pageInput.type = 'text';
  pageInput.className = 'chunk-page';
  pageInput.placeholder = 'Page / Line';
  pageInput.value = chunk.page || (chunk.pageNumber ? String(chunk.pageNumber) : '');
  const removeButton = document.createElement('button');
  removeButton.className = 'btn-remove-chunk';
  removeButton.title = 'Delete chunk';
  removeButton.textContent = '✕';
  header.append(sourceInput, pageInput, removeButton);
  const contentInput = document.createElement('textarea');
  contentInput.className = 'chunk-content';
  contentInput.placeholder = 'Enter extracted text chunk...';
  contentInput.value = chunk.content || chunk.text || '';
  card.append(header, contentInput);

  card.querySelector('.btn-remove-chunk').addEventListener('click', () => {
    card.remove();
    updateLivePrompt();
  });

  card.querySelectorAll('input, textarea').forEach(el => {
    el.addEventListener('input', updateLivePrompt);
  });

  return card;
}

function getChunks() {
  const cards = chunksList.querySelectorAll('.chunk-card');
  const chunks = [];
  cards.forEach(card => {
    const source = card.querySelector('.chunk-source').value.trim();
    const page = card.querySelector('.chunk-page').value.trim();
    const content = card.querySelector('.chunk-content').value.trim();
    if (content || source || page) {
      const embeddingKey = `${source}|${page}|${content}`;
      chunks.push({
        source: source || undefined,
        page: page || undefined,
        content: content || '',
        // NEW: Uploaded chunks retain their extraction metadata for retrieval/citations.
        ...(card.dataset.fileType ? {
          fileType: card.dataset.fileType,
          pageNumber: card.dataset.pageNumber ? Number(card.dataset.pageNumber) : null,
          chunkIndex: card.dataset.chunkIndex ? Number(card.dataset.chunkIndex) : null,
          text: content || ''
        } : {}),
        // NEW: Vectors stay in client memory and are never displayed as chunk text.
        ...(chunkEmbeddings.has(embeddingKey) ? { embedding: chunkEmbeddings.get(embeddingKey) } : {})
      });
    }
  });
  return chunks;
}

function setChunks(chunks) {
  chunksList.innerHTML = '';
  chunks.forEach(c => chunksList.appendChild(createChunkElement(c)));
  updateLivePrompt();
}

function loadPresetForMode(mode) {
  const preset = presets[mode];
  if (!preset) return;

  setChunks(preset.chunks);
  userQuestionInput.value = preset.question;
  updateLivePrompt();
}

// Mode Selection
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    
    const titles = {
      universal: 'Universal Mode',
      documentQA: 'Document / PDF Q&A',
      studyAssistant: 'Study Assistant',
      codebaseAssistant: 'Codebase Engineer'
    };
    modeBadge.textContent = titles[currentMode] || currentMode;

    // Mode selection changes generation instructions only. Context is preserved.
    updateLivePrompt();
  });
});

// Update Live System Prompt Preview & API code
async function updateLivePrompt() {
  // Preview the same retrieval result that will reach the RAG API.
  const retrieval = await getTopChunks(getChunks(), userQuestionInput.value.trim());
  const chunks = retrieval.chunks;
  try {
    const res = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: currentMode, chunks })
    });
    const data = await res.json();
    promptCodePreview.querySelector('code').textContent = data.systemPrompt;

    updateApiCodeSnippet(data.systemPrompt);
  } catch (err) {
    console.error('Failed to update live prompt preview:', err);
  }
}

function updateApiCodeSnippet() {
  const question = userQuestionInput.value || 'Your query here';
  const snippet = `// Browser call: your server owns ANTHROPIC_API_KEY.
// Never call Anthropic directly from frontend JavaScript.
const response = await fetch('/api/query', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    mode: '${currentMode}',
    chunks: [/* retrieved context chunks */],
    question: ${JSON.stringify(question)}
  })
});

const data = await response.json();
console.log(data.answer);`;

  apiCodeContent.textContent = snippet;
}

// Add Chunk Button
btnAddChunk.addEventListener('click', () => {
  chunksList.appendChild(createChunkElement());
  updateLivePrompt();
});

// NEW: Frontend-only document extraction and chunk ingestion.
const ALLOWED_DOCUMENT_TYPES = new Set(['pdf', 'txt', 'md', 'docx']);
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

function sanitizeFilename(name) {
  return (name || 'document').replace(/[<>"'`&\\/\\\\]/g, '_').replace(/[\u0000-\u001F]/g, '').slice(0, 180) || 'document';
}

function showUploadStatus(message, type = 'info') {
  uploadStatusBanner.textContent = message;
  uploadStatusBanner.className = `upload-status-banner ${type}`;
  uploadStatusBanner.style.display = 'flex';
}

function setUploadBusy(isBusy, label = 'Upload Document') {
  btnUploadDoc.disabled = isBusy;
  uploadBtnText.textContent = label;
}

function splitTextIntoChunks(text, source, fileType, pageNumber) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  const size = 500;
  const overlap = 50;
  for (let start = 0, chunkIndex = 1; start < normalized.length; start += size - overlap, chunkIndex += 1) {
    const chunkText = normalized.slice(start, start + size).trim();
    if (chunkText) {
      chunks.push({
        source,
        fileType,
        pageNumber,
        chunkIndex,
        text: chunkText,
        // Compatibility with the existing chunk cards and API contract.
        page: pageNumber ? String(pageNumber) : `Chunk ${chunkIndex}`,
        content: chunkText
      });
    }
  }
  return chunks;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(file);
  });
}

async function extractDocumentChunks(file, fileType, source) {
  if (fileType === 'txt' || fileType === 'md') {
    return splitTextIntoChunks(await readFileAsText(file), source, fileType);
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  if (fileType === 'docx') {
    if (!window.mammoth) throw new Error('DOCX extraction library did not load. Check your network connection and try again.');
    const result = await window.mammoth.extractRawText({ arrayBuffer });
    return splitTextIntoChunks(result.value, source, fileType);
  }

  if (!window.pdfjsLib) throw new Error('PDF extraction library did not load. Check your network connection and try again.');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const chunks = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    chunks.push(...splitTextIntoChunks(pageText, source, fileType, pageNumber));
  }
  return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index + 1 }));
}

// NEW: Generate local vectors after extraction. Failed downloads leave keyword
// retrieval available, so uploads and queries never depend on embeddings.
async function embedUploadedChunks(chunks) {
  const { embedText } = await import('./utils/embedder.js');
  for (let index = 0; index < chunks.length; index += 1) {
    showUploadStatus(`⚡ Generating embeddings… (${index + 1}/${chunks.length} chunks)`, 'info');
    const chunk = chunks[index];
    const embedding = await embedText(chunk.text);
    chunkEmbeddings.set(`${chunk.source}|${chunk.page}|${chunk.content}`, embedding);
  }
}

btnUploadDoc.addEventListener('click', () => fileUploadInput.click());
fileUploadInput.addEventListener('change', async () => {
  const file = fileUploadInput.files && fileUploadInput.files[0];
  fileUploadInput.value = '';
  if (!file) return;

  const fileType = file.name.split('.').pop().toLowerCase();
  if (!ALLOWED_DOCUMENT_TYPES.has(fileType)) {
    showUploadStatus('Unsupported file type. Choose a PDF, TXT, MD, or DOCX file.', 'error');
    return;
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    showUploadStatus('File is too large. Documents must be 10 MB or smaller.', 'error');
    return;
  }

  const source = sanitizeFilename(file.name);
  try {
    setUploadBusy(true, 'Uploading document…');
    showUploadStatus(`Uploading document: ${source}`, 'info');
    await new Promise(resolve => requestAnimationFrame(resolve));
    setUploadBusy(true, 'Extracting and processing document…');
    showUploadStatus('Extracting and processing document…', 'info');
    const uploadedChunks = await extractDocumentChunks(file, fileType, source);
    if (!uploadedChunks.length) throw new Error('No readable text was found in this document.');
    uploadedChunks.forEach(chunk => chunksList.appendChild(createChunkElement(chunk)));
    try {
      await embedUploadedChunks(uploadedChunks);
      showUploadStatus('✅ Semantic search ready', 'success');
    } catch (embeddingError) {
      console.warn('Embeddings unavailable; keyword retrieval remains active.', embeddingError);
      showUploadStatus(`Added ${uploadedChunks.length} chunks. Keyword search is active until embeddings are available.`, 'success');
    }
    await updateLivePrompt();
  } catch (err) {
    console.error('Document upload failed:', err);
    showUploadStatus(`Document upload failed: ${err.message}`, 'error');
  } finally {
    setUploadBusy(false);
  }
});

// Presets Controls
btnLoadPreset.addEventListener('click', () => {
  const hasUploadedDocuments = getChunks().some(chunk => chunk.fileType);
  if (hasUploadedDocuments && !window.confirm('Load this mode’s example scenario? This will replace your uploaded document chunks.')) {
    return;
  }
  loadPresetForMode(currentMode);
});
btnClearChunks.addEventListener('click', () => setChunks([]));
userQuestionInput.addEventListener('input', updateLivePrompt);

// NEW: Conversation history is local to this page session and never becomes context.
function renderConversationHistory() {
  conversationHistoryEl.replaceChildren();
  const recent = conversationHistory.slice(-10);
  conversationHistoryEl.hidden = recent.length === 0;
  recent.forEach(message => {
    const item = document.createElement('div');
    item.className = `conversation-message ${message.role}`;
    item.textContent = message.content;
    conversationHistoryEl.appendChild(item);
  });
}

btnClearConversation.addEventListener('click', () => {
  conversationHistory = [];
  renderConversationHistory();
});

// NEW: Query metrics remain in memory and can be exported without a backend.
function renderEvaluation() {
  const average = (total, count, suffix = '') => count ? `${(total / count).toFixed(suffix === '%' ? 0 : 2)}${suffix}` : '—';
  const cards = [
    ['Total Queries', evaluationMetrics.totalQueries],
    ['Avg Relevance Score', average(evaluationMetrics.relevanceTotal, evaluationMetrics.relevanceCount)],
    ['Avg Answer Length', `${average(evaluationMetrics.answerTokensTotal, evaluationMetrics.totalQueries)} tokens`],
    ['Citation Rate', average(evaluationMetrics.citedCount * 100, evaluationMetrics.totalQueries, '%')],
    ['Refusal Rate', average(evaluationMetrics.refusalCount * 100, evaluationMetrics.totalQueries, '%')],
    ['Avg Chunks Retrieved', average(evaluationMetrics.chunksTotal, evaluationMetrics.totalQueries)]
  ];
  evaluationMetricsEl.replaceChildren(...cards.map(([label, value]) => {
    const card = document.createElement('div');
    card.className = 'evaluation-metric';
    const title = document.createElement('span'); title.textContent = label;
    const number = document.createElement('strong'); number.textContent = value;
    card.append(title, number); return card;
  }));
  evaluationHistoryEl.replaceChildren(...evaluationMetrics.queryHistory.slice(-10).reverse().map(item => {
    const row = document.createElement('div');
    row.className = 'evaluation-query';
    row.textContent = `Q: ${item.question}\nRelevance: ${item.relevance ?? 'N/A (keyword mode)'} | Length: ${item.answerTokens} tokens | ${item.cited ? '✅ Cited' : '⚪ Not cited'}${item.refused ? ' | 🚫 Refused' : ''}`;
    return row;
  }));
}

btnExportEvaluation.addEventListener('click', () => {
  const report = { ...evaluationMetrics, retrievalMode: chunkEmbeddings.size ? 'semantic' : 'keyword' };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'rag-evaluation-report.json'; link.click(); URL.revokeObjectURL(url);
});

// View Tabs
[
  { tab: tabAnsView, view: viewAnswer },
  { tab: tabPromptView, view: viewPrompt },
  { tab: tabApiCodeView, view: viewApiCode },
  { tab: tabEvaluationView, view: viewEvaluation }
].forEach(({ tab, view }) => {
  tab.addEventListener('click', () => {
    [tabAnsView, tabPromptView, tabApiCodeView, tabEvaluationView].forEach(t => t.classList.remove('active'));
    [viewAnswer, viewPrompt, viewApiCode, viewEvaluation].forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    view.classList.add('active');
  });
});

// Copy Buttons
btnCopyPrompt.addEventListener('click', () => {
  navigator.clipboard.writeText(promptCodePreview.querySelector('code').textContent);
  btnCopyPrompt.textContent = '✅ Copied!';
  setTimeout(() => { btnCopyPrompt.textContent = '📋 Copy Prompt'; }, 2000);
});

btnCopyApiCode.addEventListener('click', () => {
  navigator.clipboard.writeText(apiCodeContent.textContent);
  btnCopyApiCode.textContent = '✅ Copied!';
  setTimeout(() => { btnCopyApiCode.textContent = '📋 Copy Code'; }, 2000);
});

// Format Output Citations
function formatCitationsInHTML(rawText) {
  // NEW: Answers can contain untrusted uploaded document text; escape it before
  // adding the small citation-only HTML wrapper.
  const escapedText = String(rawText)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  // Highlight (Source: ..., Page ...) or (File: ..., Line ...)
  const citationRegex = /\((Source|File): [^)]+\)/g;
  return escapedText.replace(citationRegex, match => `<span class="citation-badge">${match}</span>`);
}

// Execute Query
btnExecuteQuery.addEventListener('click', async () => {
  const question = userQuestionInput.value.trim();
  if (!question) {
    alert('Please enter a question first.');
    return;
  }

  // Switch to answer view
  tabAnsView.click();

  // Broad queries expand and diversify context; focused queries retain top three.
  const retrieval = await getTopChunks(getChunks(), question);
  const chunks = retrieval.chunks;

  responseStatusBadge.className = 'badge';
  responseStatusBadge.textContent = 'Querying Claude API...';
  
  answerContainer.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px; color: var(--text-secondary); margin: auto;">
      <div style="width: 20px; height: 20px; border: 2px solid var(--accent-primary); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
      <span>Running RAG retrieval synthesis & anti-hallucination verification...</span>
    </div>
    <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
  `;

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: currentMode,
        chunks,
        question,
        // Last three exchanges support follow-up questions in Claude.
        conversationHistory: conversationHistory.slice(-6)
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Query failed');
    }

    responseStatusBadge.className = 'badge badge-live';
    responseStatusBadge.textContent = data.generation === 'local-fallback'
      ? '📄 Grounded Local Response'
      : '⚡ Claude Response';

    const formattedAnswer = formatCitationsInHTML(data.answer);
    
    answerContainer.innerHTML = `
      <div>${formattedAnswer}</div>
      ${data.note ? `<div style="margin-top: 16px; font-size: 0.78rem; color: var(--text-muted); border-top: 1px solid var(--border-color); padding-top: 10px;">ℹ️ ${data.note}</div>` : ''}
    `;

    // NEW: Record chat and evaluation data after every successful query.
    conversationHistory.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer });
    renderConversationHistory();
    const answerTokens = Math.round(data.answer.trim().split(/\s+/).filter(Boolean).length * 1.3);
    const cited = /\((Source|File): [^)]+\)|\bSource:/i.test(data.answer);
    const refused = data.answer.includes("I don't have enough information");
    evaluationMetrics.totalQueries += 1;
    evaluationMetrics.answerTokensTotal += answerTokens;
    evaluationMetrics.citedCount += cited ? 1 : 0;
    evaluationMetrics.refusalCount += refused ? 1 : 0;
    evaluationMetrics.chunksTotal += chunks.length;
    if (retrieval.relevance !== null) { evaluationMetrics.relevanceTotal += retrieval.relevance; evaluationMetrics.relevanceCount += 1; }
    evaluationMetrics.queryHistory.push({ question, relevance: retrieval.relevance === null ? null : Number(retrieval.relevance.toFixed(2)), answerTokens, cited, refused, retrievalMode: retrieval.mode });
    evaluationMetrics.queryHistory = evaluationMetrics.queryHistory.slice(-10);
    renderEvaluation();

  } catch (err) {
    responseStatusBadge.className = 'badge';
    responseStatusBadge.style.color = '#f43f5e';
    responseStatusBadge.textContent = 'Execution Error';
    answerContainer.innerHTML = `<div style="color: #fda4af;"><strong>Error:</strong> ${err.message}</div>`;
  }
});

// Initialize
// Keep the search/question field empty on startup; examples only fill it after
// the user explicitly chooses "Load Example Scenario".
userQuestionInput.value = '';
renderEvaluation();
initPresets();

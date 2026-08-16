import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSystemPrompt, formatChunks, RAG_TEMPLATES } from './src/prompts.js';
import { queryRAG } from './src/ragClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const PRESETS = {
  universal: {
    question: 'How much is the internet reimbursement for remote staff and who approves monitors?',
    chunks: [
      {
        source: 'HR_Benefits_2026.pdf',
        page: '12',
        content: 'Remote employees are eligible for a $50/month home internet stipend processed directly through payroll.'
      },
      {
        source: 'Equipment_Policy.pdf',
        page: '4',
        content: 'Requests for peripheral hardware such as external monitors, docking stations, and ergonomic chairs require sign-off from the department manager.'
      }
    ]
  },
  documentQA: {
    question: 'What was the Q3 revenue growth and what was the main driver?',
    chunks: [
      {
        source: 'Financial_Report_Q3.pdf',
        page: '7',
        content: 'Total revenue grew by 18% year-over-year to $42.5M. The primary growth driver was a 34% surge in Enterprise Tier expansions across North America.'
      }
    ]
  },
  studyAssistant: {
    question: 'What is QuickSort and how does its partitioning step work?',
    chunks: [
      {
        source: 'Algorithms_Lecture_6.md',
        content: 'QuickSort is a divide-and-conquer sorting algorithm with average-case time complexity of O(n log n). The partition step picks an element as a pivot and partitions the given array around the picked pivot by placing all smaller elements before the pivot and all greater elements after it.'
      }
    ]
  },
  codebaseAssistant: {
    question: 'How does authentication work in our auth route and what status code is sent if missing token?',
    chunks: [
      {
        source: 'src/routes/auth.js',
        line: '42-46',
        content: `export async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}`
      }
    ]
  }
};

function buildSimulatorIntro(question) {
  if (/steps/i.test(question)) return 'The main steps involve the following:';
  if (/outcomes/i.test(question)) return 'The course outcomes are as follows:';
  if (/features/i.test(question)) return 'The key features include:';
  if (/types/i.test(question)) return 'The types identified are:';
  if (/what are/i.test(question)) return 'Based on the document, the answer is:';
  return 'Here is the relevant information from the document:';
}

// Formats retrieved evidence into a concise, cited answer. It deliberately
// selects sentences/items instead of returning a complete retrieval chunk.
function simulateAnswer(topChunks, question) {
  const refusal = "I don't have enough information in the provided document to answer this question.";
  if (!topChunks?.length) return refusal;

  const q = question.toLowerCase().trim();
  const best = topChunks[0];
  const MIN_RELEVANCE_SCORE = 0.15;
  if (best.score !== undefined && best.score < MIN_RELEVANCE_SCORE) return refusal;

  const isListQuestion = /what are|list|steps|outcomes|features|types|enumerate|how many|give me|name the/i.test(q);
  const isDefinitionQuestion = /what is|what does|define|explain|describe|tell me about|meaning of/i.test(q);
  const isHowQuestion = /how (do|does|can|to|is)|process|procedure|method/i.test(q);
  const isYesNoQuestion = /^(is|are|was|were|does|do|did|has|have|can|could|should|would)/i.test(q);
  const allText = topChunks.map(chunk => String(chunk.text || chunk.content || '')).join(' ').replace(/\s+/g, ' ').trim();
  const questionWords = q.replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(word => word.length > 3 && !['what', 'that', 'this', 'with', 'from', 'have', 'will', 'your', 'they', 'been', 'were', 'when', 'where'].includes(word));
  const sentences = allText.split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 20 && sentence.length < 300);
  const topSentences = sentences
    .map(sentence => ({
      sentence,
      score: questionWords.reduce((score, word) => score + (sentence.toLowerCase().includes(word) ? 2 : 0) + (sentence.toLowerCase().startsWith(word) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, isListQuestion ? 6 : 3)
    .map(result => result.sentence);
  const hasPage = best.pageNumber || (best.page && !/^chunk\s/i.test(best.page));
  const citation = hasPage
    ? `Source: ${best.source || 'uploaded document'}, Page ${best.pageNumber || best.page}`
    : `Source: ${best.source || 'uploaded document'}, Chunk ${best.chunkIndex || 1}`;

  if (isListQuestion) {
    const bulletItems = [...allText.matchAll(/[•*]\s*(.+?)(?=(?:[•*]\s*)|$)/g)]
      .map(match => match[1].trim())
      .filter(item => item.length > 5 && item.length < 300);
    const numberedItems = [...allText.matchAll(/\d+[.)]\s*(.+?)(?=\d+[.)]\s*|$)/g)]
      .map(match => match[1].trim())
      .filter(item => item.length > 5 && item.length < 300);
    const items = (bulletItems.length >= 2 ? bulletItems : numberedItems.length >= 2 ? numberedItems : topSentences)
      .slice(0, 8);
    if (!items.length) return refusal;
    return `${buildSimulatorIntro(q)}\n\n${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\n${citation}`;
  }

  const answer = topSentences.slice(0, isYesNoQuestion ? 1 : 3).join(' ');
  if (!answer || answer.length < 20) return refusal;
  return `${answer}\n\n${citation}`;
}

function simulateResponse(mode, chunks, question) {
  // Uploaded documents use deterministic lexical matching before synthesis.
  const uploadedChunks = chunks.filter(chunk => chunk.fileType && (chunk.text || chunk.content));
  if (uploadedChunks.length) {
    const refusal = "I don't have enough information in the provided document to answer this question.";
    const terms = question.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    const ignoredTerms = new Set(['what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'have', 'does', 'about', 'would', 'could', 'should', 'document', 'context', 'provided']);
    const queryTerms = [...new Set(terms.filter(term => !ignoredTerms.has(term)))];
    const matches = uploadedChunks
      .map(chunk => ({
        chunk,
        score: queryTerms.reduce((score, term) => score + (String(chunk.text || chunk.content).toLowerCase().includes(term) ? 1 : 0), 0)
      }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (!matches.length) {
      return refusal;
    }

    const scoredChunks = matches.map(({ chunk, score }) => ({
      ...chunk,
      score: score / Math.max(queryTerms.length, 1)
    }));
    return simulateAnswer(scoredChunks, question);
  }

  const combinedContext = chunks.map(c => c.content.toLowerCase()).join(' ');
  const qLower = question.toLowerCase();

  // Basic simulation fallback demonstrating guardrail behavior
  if (mode === 'universal') {
    if (qLower.includes('internet') || qLower.includes('monitor') || qLower.includes('reimburse')) {
      return `Remote employees receive a $50/month home internet stipend through payroll (Source: HR_Benefits_2026.pdf, Page 12). Equipment requests for external monitors require approval from the department manager (Source: Equipment_Policy.pdf, Page 4).`;
    }
    return `I don't have that information in the provided documents.`;
  }

  if (mode === 'documentQA') {
    if (qLower.includes('revenue') || qLower.includes('growth') || qLower.includes('q3')) {
      return `Total revenue grew by 18% year-over-year to $42.5M, driven primarily by a 34% surge in Enterprise Tier expansions across North America.\n\nSource: Financial_Report_Q3.pdf, Page 7`;
    }
    return `This information is not in the uploaded documents.`;
  }

  if (mode === 'studyAssistant') {
    if (qLower.includes('quicksort') || qLower.includes('pivot') || qLower.includes('partition')) {
      return `According to your notes, QuickSort is a divide-and-conquer sorting algorithm with an average-case time complexity of O(n log n).\n\nHere is how the partition step works:\n1. A pivot element is selected.\n2. The array is reorganized so that all elements smaller than the pivot move before it, and all larger elements move after it.\n3. The pivot is then placed in its correct sorted position.\n\nWould you like me to quiz you on this topic?`;
    }
    return `This topic isn't in your current notes. You may want to check your textbook.`;
  }

  if (mode === 'codebaseAssistant') {
    if (qLower.includes('token') || qLower.includes('auth') || qLower.includes('status')) {
      return `The authentication middleware \`verifyToken\` extracts the bearer token from the \`Authorization\` header. If the token is missing, it immediately returns a \`401\` status code with \`{ error: 'Missing token' }\` (File: src/routes/auth.js, Line 42-46).\n\nIf the token is present, it is verified against \`JWT_SECRET\` using \`jwt.verify()\`. If invalid, it returns \`403\` (Invalid token).`;
    }
    return `I can see snippets in your codebase but the relevant code for your request wasn't retrieved — try searching for auth or user routes.`;
  }

  return `I don't have that information in the provided documents.`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: Get Presets
  if (url.pathname === '/api/presets' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(PRESETS));
    return;
  }

  // API: Build Prompt
  if (url.pathname === '/api/prompt' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { mode = 'universal', chunks = [] } = JSON.parse(body || '{}');
        const systemPrompt = buildSystemPrompt(mode, chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ systemPrompt, template: RAG_TEMPLATES[mode] }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Query RAG
  if (url.pathname === '/api/query' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const {
          mode = 'universal',
          chunks = [],
          question = '',
          apiKey = '',
          conversationHistory = [],
          useMock = false
        } = JSON.parse(body || '{}');

        if (!question.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Question cannot be empty' }));
          return;
        }

        const systemPrompt = buildSystemPrompt(mode, chunks);

        // If user provided an API key and didn't force mock, call Claude live
        if (apiKey && !useMock) {
          try {
            const ragResult = await queryRAG({
              userQuestion: question,
              retrievedChunks: chunks,
              promptType: mode,
              apiKey,
              conversationHistory
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              answer: ragResult.text,
              systemPrompt,
              mode,
              isLive: true
            }));
            return;
          } catch (apiErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `API Call Failed: ${apiErr.message}` }));
            return;
          }
        }

        // Otherwise return simulated intelligent RAG response
        const simulatedAnswer = simulateResponse(mode, chunks, question);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          answer: simulatedAnswer,
          systemPrompt,
          mode,
          isLive: false,
          note: 'Generated via built-in RAG Simulator. Provide an Anthropic API Key for live Claude 3.7 / 4.6 generation.'
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(content);
    }
  });
});

function startServer(portToTry) {
  server.listen(portToTry, () => {
    console.log(`\n🚀 RAG Studio Server running at http://localhost:${portToTry}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Port ${portToTry} is in use. Trying port ${portToTry + 1}...`);
      startServer(portToTry + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(PORT);

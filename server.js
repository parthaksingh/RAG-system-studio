import 'dotenv/config';
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

// Keep the studio available even while credentials are being configured. Query
// requests receive a clear error from queryRAG; never log the key itself.
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.warn(
    'Configuration warning: ANTHROPIC_API_KEY is missing. The page will load, ' +
      'but answers require a key in .env (see .env.example).'
  );
} else if (!process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
  console.warn(
    'Configuration warning: ANTHROPIC_API_KEY is not an Anthropic key. The page ' +
      'will load, but answers require a valid key starting with "sk-ant-".'
  );
}

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

function citationFor(chunk) {
  const source = chunk.source || 'provided document';
  const location = chunk.page ?? chunk.pageNumber ?? chunk.line;
  return location ? `(Source: ${source}, Page ${location})` : `(Source: ${source})`;
}

// A no-network fallback for document questions. It never invents facts: it
// extracts only relationship names or high-scoring sentences from retrieved
// chunks and keeps their source citation.
function buildGroundedFallback(question, chunks) {
  if (!chunks.length) {
    return "I don't have enough information in the provided document/context to answer this.";
  }

  const context = chunks.map(chunk => ({
    ...chunk,
    content: String(chunk.content || chunk.text || '')
  }));
  const relationshipQuestion = /(?:task\s+)?linkage|relationship/i.test(question);
  const relationships = [];
  for (const chunk of context) {
    const matches = chunk.content.matchAll(/\b(Finish|Start)\s*(?:-|to)\s*(Finish|Start)\b/gi);
    for (const match of matches) {
      const label = `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}-to-${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}`;
      if (!relationships.some(item => item.label === label)) relationships.push({ label, chunk });
    }
  }
  if (relationshipQuestion && relationships.length) {
    return `The task-linkage relationships listed are:\n${relationships
      .map(item => `- ${item.label} ${citationFor(item.chunk)}`)
      .join('\n')}`;
  }

  const keywords = question.toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 3) || [];
  const ranked = context
    .map(chunk => {
      const sentences = chunk.content.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [chunk.content];
      const bestSentence = sentences
        .map(sentence => ({ sentence: sentence.trim(), score: keywords.reduce((total, word) => total + (sentence.toLowerCase().includes(word) ? 1 : 0), 0) }))
        .sort((a, b) => b.score - a.score)[0];
      return { chunk, ...bestSentence };
    })
    .filter(item => item.sentence && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (!ranked.length) {
    return "I don't have enough information in the provided document/context to answer this.";
  }
  return ranked.map(item => `${item.sentence} ${citationFor(item.chunk)}`).join('\n\n');
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
      let queryQuestion = '';
      let queryChunks = [];
      let systemPrompt;
      let queryMode = 'universal';
      try {
        const {
          mode = 'universal',
          chunks = [],
          question = '',
          conversationHistory = []
        } = JSON.parse(body || '{}');

        queryQuestion = question;
        queryChunks = chunks;
        queryMode = mode;

        if (typeof question !== 'string' || !question.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Question cannot be empty' }));
          return;
        }

        if (!Array.isArray(chunks)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Chunks must be an array.' }));
          return;
        }

        const safeHistory = Array.isArray(conversationHistory)
          ? conversationHistory.filter(message =>
            message &&
            (message.role === 'user' || message.role === 'assistant') &&
            typeof message.content === 'string'
          )
          : [];

        systemPrompt = buildSystemPrompt(mode, chunks);

        const ragResult = await queryRAG({
          userQuestion: question,
          retrievedChunks: chunks,
          promptType: mode,
          conversationHistory: safeHistory
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer: ragResult.text, systemPrompt, mode }));
      } catch (err) {
        const fallbackAnswer = buildGroundedFallback(queryQuestion, queryChunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          answer: fallbackAnswer,
          systemPrompt,
          mode: queryMode,
          generation: 'local-fallback',
          note: 'Claude is unavailable, so this answer was extracted only from the retrieved document context.'
        }));
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
  // Do not pass a callback directly to listen(): if a port attempt fails, that
  // callback stays attached and would incorrectly log on a later retry.
  const onListening = () => {
    cleanup();
    console.log(`\n🚀 RAG Studio Server running at http://localhost:${portToTry}`);
  };

  const onError = (err) => {
    cleanup();
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Port ${portToTry} is in use. Trying port ${portToTry + 1}...`);
      startServer(portToTry + 1);
    } else {
      console.error('Server error:', err);
    }
  };

  const cleanup = () => {
    server.off('listening', onListening);
    server.off('error', onError);
  };

  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(portToTry);
}

startServer(PORT);

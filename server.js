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

// Fail fast so a missing secret is caught at launch, not after a user submits a
// question. Never log the key itself.
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error(
    'Configuration error: ANTHROPIC_API_KEY is missing. Add it to .env locally ' +
      '(see .env.example) or configure it in your hosting provider environment variables.'
  );
  process.exit(1);
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
          conversationHistory = []
        } = JSON.parse(body || '{}');

        if (!question.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Question cannot be empty' }));
          return;
        }

        const systemPrompt = buildSystemPrompt(mode, chunks);

        const ragResult = await queryRAG({
          userQuestion: question,
          retrievedChunks: chunks,
          promptType: mode,
          conversationHistory
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer: ragResult.text, systemPrompt, mode }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unable to generate an answer: ${err.message}` }));
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

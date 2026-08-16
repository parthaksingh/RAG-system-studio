import { buildSystemPrompt, formatChunks, RAG_TEMPLATES } from './prompts.js';

console.log('='.repeat(60));
console.log('🤖 RAG SYSTEM PROMPTS & BUILDER DEMO');
console.log('='.repeat(60));

// 1. Universal RAG Demo
const universalChunks = [
  {
    source: 'company_policy.pdf',
    page: 12,
    content: 'Remote employees are eligible for a $50/month home internet stipend processed through payroll.'
  },
  {
    source: 'company_policy.pdf',
    page: 14,
    content: 'Equipment requests for external monitors must be approved by the department manager.'
  }
];

console.log('\n--- 1. UNIVERSAL RAG PROMPT ---');
console.log(buildSystemPrompt('universal', universalChunks));

// 2. Document Q&A Demo
const documentChunks = [
  {
    source: 'Quarterly_Report_Q3.pdf',
    page: 5,
    content: 'Total revenue grew by 18% year-over-year to $42.5M, driven by strong enterprise tier adoption.'
  }
];

console.log('\n--- 2. DOCUMENT / PDF Q&A PROMPT ---');
console.log(buildSystemPrompt('documentQA', documentChunks));

// 3. Study / Notes Assistant Demo
const studyNotes = [
  {
    source: 'CS101_Lecture_4.md',
    content: 'Binary Search operates on sorted arrays in O(log n) time by repeatedly dividing the search interval in half.'
  }
];

console.log('\n--- 3. STUDY / NOTES ASSISTANT PROMPT ---');
console.log(buildSystemPrompt('studyAssistant', studyNotes));

// 4. Codebase Assistant Demo
const codeSnippets = [
  {
    source: 'src/routes/auth.js',
    line: 42,
    content: `export async function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  // JWT verification logic
}`
  }
];

console.log('\n--- 4. CODEBASE ASSISTANT PROMPT ---');
console.log(buildSystemPrompt('codebaseAssistant', codeSnippets));

console.log('\n' + '='.repeat(60));
console.log('✅ Demo generated successfully.');
console.log('='.repeat(60));

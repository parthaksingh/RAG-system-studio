# RAG Application & System Prompts

Production-ready Retrieval-Augmented Generation (RAG) system prompts, dynamic prompt builders, and Anthropic Claude integration.

---

## 📁 Repository Structure

- [`SYSTEM_PROMPTS.md`](file:///Users/parrthaksingh/RAG%20application/SYSTEM_PROMPTS.md): Complete prompt catalog for quick copy-pasting.
- [`src/prompts.js`](file:///Users/parrthaksingh/RAG%20application/src/prompts.js): Template strings, dynamic context chunk formatters, and builder functions.
- [`src/ragClient.js`](file:///Users/parrthaksingh/RAG%20application/src/ragClient.js): Claude Messages API wrapper.
- [`src/demo.js`](file:///Users/parrthaksingh/RAG%20application/src/demo.js): Runnable demo across all 4 prompt configurations.
- [`src/index.js`](file:///Users/parrthaksingh/RAG%20application/src/index.js): Main library exports.

---

## 🚀 Quick Start

### 1. Run the Demo
```bash
node src/demo.js
```

### 2. Basic Code Usage

```javascript
import { buildSystemPrompt, queryRAG } from './src/index.js';

// Retrieve chunks from your vector DB
const retrievedChunks = [
  {
    source: 'Quarterly_Report_Q3.pdf',
    page: 5,
    content: 'Total revenue grew by 18% YoY to $42.5M.'
  }
];

// Generate the populated prompt
const systemPrompt = buildSystemPrompt('documentQA', retrievedChunks);

// Query Claude
const response = await queryRAG({
  userQuestion: 'What was the Q3 revenue growth?',
  retrievedChunks,
  promptType: 'documentQA',
  apiKey: process.env.ANTHROPIC_API_KEY
});

console.log(response.text);
```

---

## 🛡️ Anti-Hallucination Principles

1. **Context Hard-Boundaries**: Explicit fallback phrases when content is missing.
2. **Mandatory Citations**: Source document + Page / Line citations for every factual claim.
3. **Preamble Elimination**: Directly outputs the answer without generic filler words.

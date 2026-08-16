/**
 * Anthropic Claude RAG Client
 */

import { buildSystemPrompt } from './prompts.js';

/**
 * Sends a RAG question to Anthropic's Claude Messages API
 * 
 * @param {Object} options
 * @param {string} options.userQuestion - The user's query
 * @param {Array<object>|string} options.retrievedChunks - Retrieved chunks or raw context string
 * @param {'universal'|'documentQA'|'studyAssistant'|'codebaseAssistant'} [options.promptType='universal'] - Prompt template type
 * @param {string} [options.apiKey] - Anthropic API key (defaults to process.env.ANTHROPIC_API_KEY)
 * @param {string} [options.model='claude-sonnet-4-6'] - Anthropic model name
 * @param {number} [options.maxTokens=1024] - Max generation tokens
 * @param {boolean} [options.injectContextInUserMessage=false] - Whether to inject chunks into the user message instead of system prompt
 * @param {Array<{role: 'user'|'assistant', content: string}>} [options.conversationHistory=[]] - Prior exchanges
 * @returns {Promise<{text: string, rawResponse: any}>}
 */
export async function queryRAG({
  userQuestion,
  retrievedChunks,
  promptType = 'universal',
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = 'claude-sonnet-4-6',
  maxTokens = 1024,
  injectContextInUserMessage = false,
  conversationHistory = [],
}) {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required to make Claude API requests.');
  }

  const groundingInstruction = 'Only answer using the provided context. If the answer is not present in the context, explicitly refuse and state the information is not available in the document.';
  let systemPrompt;
  let userContent;

  if (injectContextInUserMessage) {
    // Style where system prompt is static and context is in user message
    systemPrompt = `${buildSystemPrompt(promptType, '').replace(/<context>[\s\S]*<\/context>/, '').trim()}\n\n${groundingInstruction}`;
    const formattedChunks = typeof retrievedChunks === 'string' ? retrievedChunks : JSON.stringify(retrievedChunks, null, 2);
    userContent = `<context>\n${formattedChunks}\n</context>\n\nQuestion: ${userQuestion}`;
  } else {
    // Standard style where system prompt embeds retrieved context
    systemPrompt = `${buildSystemPrompt(promptType, retrievedChunks)}\n\n${groundingInstruction}`;
    userContent = userQuestion;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [
          ...conversationHistory.slice(-6),
          { role: 'user', content: userContent }
        ]
      })
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Claude API request timed out. Please try again.');
    throw new Error(`Claude API request failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API Error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  return {
    text,
    rawResponse: data
  };
}

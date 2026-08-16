#!/usr/bin/env node
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { buildSystemPrompt, formatChunks } from './prompts.js';
import { queryRAG } from './ragClient.js';

const rl = readline.createInterface({ input, output });

async function main() {
  console.clear();
  console.log('='.repeat(60));
  console.log('⚡ RAG Interactive CLI Explorer');
  console.log('='.repeat(60));
  console.log('1. Universal RAG');
  console.log('2. PDF & Document Q&A');
  console.log('3. Study / Notes Assistant');
  console.log('4. Codebase / Technical Assistant');
  console.log('='.repeat(60));

  const choice = await rl.question('\nSelect prompt mode (1-4) [default: 1]: ');
  const modeMap = {
    '1': 'universal',
    '2': 'documentQA',
    '3': 'studyAssistant',
    '4': 'codebaseAssistant'
  };
  const mode = modeMap[choice.trim()] || 'universal';

  console.log(`\nSelected Mode: ${mode}`);
  console.log('\nEnter retrieved context chunk (type your context text, then press Enter):');
  const contextText = await rl.question('> ');

  const source = await rl.question('\nEnter Source file / doc name (optional): ');
  const page = await rl.question('Enter Page / Line number (optional): ');

  const chunks = [
    {
      source: source.trim() || undefined,
      page: page.trim() || undefined,
      content: contextText.trim() || 'No text provided.'
    }
  ];

  const question = await rl.question('\nEnter your question: ');

  console.log('\n' + '='.repeat(60));
  console.log('📝 Generated System Prompt:');
  console.log('='.repeat(60));
  const fullPrompt = buildSystemPrompt(mode, chunks);
  console.log(fullPrompt);

  const runApi = await rl.question('\nWould you like to call Claude API? (y/N): ');
  if (runApi.trim().toLowerCase() === 'y') {
    const apiKey = process.env.ANTHROPIC_API_KEY || (await rl.question('Enter ANTHROPIC_API_KEY: '));
    if (!apiKey) {
      console.log('⚠️ No API key provided. Skipping API call.');
    } else {
      console.log('\nQuerying Claude API...');
      try {
        const result = await queryRAG({
          userQuestion: question,
          retrievedChunks: chunks,
          promptType: mode,
          apiKey
        });
        console.log('\n--- Claude Response ---');
        console.log(result.text);
      } catch (err) {
        console.error('❌ Error querying API:', err.message);
      }
    }
  }

  console.log('\n✨ Done!');
  rl.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

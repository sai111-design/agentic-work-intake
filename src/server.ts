/**
 * Server entry point.
 *
 * Wires up the database, LLM provider, tools, and Express app.
 * Starts listening on the configured port.
 */

import { config, isLlmConfigured } from './config.js';
import { getDb } from './db/index.js';
import { GeminiProvider } from './llm/gemini.js';
import type { LLMProvider } from './llm/provider.js';
import { LlmError } from './llm/provider.js';
import { initTools } from './tools/init.js';
import { createApp } from './api.js';

// --- Provider ---
// Use GeminiProvider always. If GEMINI_API_KEY is not set, the provider's
// .configured property will be false and interpret() will throw LLM_NOT_CONFIGURED.
// The app still starts — it just shows a health banner.
const provider: LLMProvider = new GeminiProvider();

if (!isLlmConfigured()) {
  console.warn('⚠  GEMINI_API_KEY is not set. The app will start but LLM calls will fail.');
  console.warn('   Set GEMINI_API_KEY in .env or environment to enable interpretation.');
}

// --- Database ---
const db = getDb();
console.log(`Database: ${config.dbPath}`);

// --- Tools ---
initTools(provider, db);
console.log('Tools registered.');

// --- Express ---
const app = createApp(provider, db);

const server = app.listen(config.port, () => {
  console.log(`\n  Agentic Work Intake running at http://localhost:${config.port}\n`);
  console.log(`  LLM: ${provider.name} / ${provider.model} (configured: ${provider.configured})`);
  console.log(`  Health: http://localhost:${config.port}/api/health\n`);
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Wire up all four tools into the registry.
 *
 * Called once at application startup. Each tool gets its dependencies injected
 * (provider, database) so the registry holds ready-to-call functions.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { LLMProvider } from '../llm/provider.js';
import { makeCreateTask } from './create-task.js';
import { makeDraftCommunication } from './draft-communication.js';
import { makeGenerateBrief } from './generate-brief.js';
import { registerTool } from './registry.js';
import { websiteCheck } from './website-check.js';

export function initTools(provider: LLMProvider, db: DatabaseSync): void {
  registerTool('draft_communication', makeDraftCommunication(provider));
  registerTool('create_task', makeCreateTask(db));
  registerTool('website_check', websiteCheck);
  registerTool('generate_brief', makeGenerateBrief(db));
}

/**
 * Fixed tool registry. The router switches over this set, and ONLY this set.
 *
 * The LLM can never invent a tool name. The deterministic planner maps each
 * action kind to a ToolName (from types.ts), and the registry resolves that
 * to a concrete execute function. Unknown names are rejected at the boundary,
 * not silently ignored.
 */

import type { ToolName } from '../core/types.js';

/** Every tool returns a structured result — never a bare string. */
export interface ToolResult {
  /** Whether the tool succeeded. Failures are recorded, never swallowed. */
  ok: boolean;
  /** Human-readable summary for the activity trace. */
  summary: string;
  /** The full structured output, persisted in actions.output. */
  data: Record<string, unknown>;
}

export type ToolFn = (input: Record<string, unknown>) => Promise<ToolResult>;

const tools = new Map<ToolName, ToolFn>();

export function registerTool(name: ToolName, fn: ToolFn): void {
  if (tools.has(name)) throw new Error(`Tool already registered: ${name}`);
  tools.set(name, fn);
}

/**
 * Look up a tool. Returns undefined for unknown names — the caller is
 * responsible for treating that as a hard error, not a no-op.
 */
export function getTool(name: string): ToolFn | undefined {
  return tools.get(name as ToolName);
}

/** Whether the name is in the fixed set. */
export function isKnownTool(name: string): name is ToolName {
  return tools.has(name as ToolName);
}

/** The names currently registered, for diagnostics and tests. */
export function registeredToolNames(): readonly ToolName[] {
  return [...tools.keys()];
}

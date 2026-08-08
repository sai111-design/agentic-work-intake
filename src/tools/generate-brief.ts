/**
 * Tool 4 — Generate Markdown Brief
 *
 * Produces a readable Markdown report from the structured request data and
 * any tool outputs already collected. For Scenario 2 (website review), this
 * becomes the technical website report. For other scenarios, it produces a
 * work brief.
 *
 * This tool reads from the database — it does not fabricate information.
 * If no data is found, it says so.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ToolResult } from './registry.js';

interface RequestRow {
  raw_text: string;
  status: string;
  interpretation: string | null;
}

interface ActionRow {
  seq: number;
  title: string;
  classification: string;
  reason: string;
  tool: string | null;
  status: string;
  output: string | null;
}

interface TaskRow {
  title: string;
  due_at: string | null;
  status: string;
}

export function makeGenerateBrief(db: DatabaseSync) {
  return async function generateBrief(input: Record<string, unknown>): Promise<ToolResult> {
    const requestId = String(input['request_id'] ?? '').trim();
    if (!requestId) {
      return { ok: false, summary: 'No request_id provided.', data: { error: 'missing_request_id' } };
    }

    const request = db.prepare(
      `SELECT raw_text, status, interpretation FROM requests WHERE id = ?`,
    ).get(requestId) as RequestRow | undefined;

    if (!request) {
      return { ok: false, summary: `Request ${requestId} not found.`, data: { error: 'not_found' } };
    }

    const actions = db.prepare(
      `SELECT seq, title, classification, reason, tool, status, output
       FROM actions WHERE request_id = ? ORDER BY seq`,
    ).all(requestId) as unknown as ActionRow[];

    const tasks = db.prepare(
      `SELECT title, due_at, status FROM tasks WHERE request_id = ?`,
    ).all(requestId) as unknown as TaskRow[];

    let interpretation: Record<string, unknown> | null = null;
    if (request.interpretation) {
      try {
        interpretation = JSON.parse(request.interpretation) as Record<string, unknown>;
      } catch { /* not valid JSON — leave null */ }
    }

    // Build the brief
    const lines: string[] = [];

    lines.push('# Work Brief');
    lines.push('');

    if (interpretation) {
      const title = String(interpretation['task_title'] ?? 'Untitled');
      const summary = String(interpretation['summary'] ?? '');
      const priority = String(interpretation['priority'] ?? 'medium');
      const deadline = interpretation['detected_deadline'];

      lines.push(`## ${title}`);
      lines.push('');
      lines.push(`**Priority:** ${priority}`);
      if (deadline) lines.push(`**Deadline:** ${String(deadline)}`);
      lines.push('');
      lines.push(summary);
      lines.push('');

      const missing = interpretation['missing_information'];
      if (Array.isArray(missing) && missing.length > 0) {
        lines.push('### Missing Information');
        lines.push('');
        for (const item of missing) {
          lines.push(`- ${String(item)}`);
        }
        lines.push('');
      }
    }

    if (actions.length > 0) {
      lines.push('## Actions');
      lines.push('');

      for (const action of actions) {
        lines.push(`### ${action.seq + 1}. ${action.title}`);
        lines.push('');
        lines.push(`- **Classification:** ${action.classification}`);
        lines.push(`- **Status:** ${action.status}`);
        if (action.tool) lines.push(`- **Tool:** ${action.tool}`);
        lines.push(`- **Reason:** ${action.reason}`);

        if (action.output) {
          try {
            const output = JSON.parse(action.output) as Record<string, unknown>;

            // Website check evidence
            if (action.tool === 'website_check' && output['http_status']) {
              lines.push('');
              lines.push('#### Website Check Results');
              lines.push('');
              lines.push('| Check | Result |');
              lines.push('|-------|--------|');
              lines.push(`| URL | ${String(output['requested_url'] ?? '')} |`);
              lines.push(`| Final URL | ${String(output['final_url'] ?? '')} |`);
              lines.push(`| HTTP Status | ${String(output['http_status'])} ${String(output['status_text'] ?? '')} |`);
              lines.push(`| Content Type | ${String(output['content_type'] ?? 'N/A')} |`);
              lines.push(`| Response Time | ${String(output['response_time_ms'])}ms |`);
              lines.push(`| Page Title | ${String(output['page_title'] ?? 'N/A')} |`);
              lines.push(`| Has DOCTYPE | ${output['has_doctype'] ? 'Yes' : 'No'} |`);
              lines.push(`| HTML Lang | ${String(output['html_lang'] ?? 'N/A')} |`);
              lines.push(`| Meta Description | ${String(output['meta_description'] ?? 'N/A')} |`);
              lines.push(`| Meta Viewport | ${String(output['meta_viewport'] ?? 'N/A')} |`);
              lines.push(`| Content Size | ${String(output['content_length_bytes'])} bytes |`);
              lines.push(`| Redirects | ${String(output['redirect_count'])} |`);

              if (Array.isArray(output['checks_performed'])) {
                lines.push('');
                lines.push('**Checks performed:**');
                for (const check of output['checks_performed'] as string[]) {
                  lines.push(`- ${check}`);
                }
              }
            }

            // Draft communication
            if (action.tool === 'draft_communication' && output['subject']) {
              lines.push('');
              lines.push('#### Draft Message');
              lines.push('');
              lines.push(`**Subject:** ${String(output['subject'])}`);
              lines.push('');
              lines.push(String(output['body'] ?? ''));
              lines.push('');
              lines.push(`*Recipients resolved: ${output['recipients_resolved'] ? 'Yes' : 'No'} | Sent: ${output['sent'] ? 'Yes' : 'No'}*`);
            }
          } catch { /* not JSON — skip */ }
        }

        lines.push('');
      }
    }

    if (tasks.length > 0) {
      lines.push('## Tasks / Reminders');
      lines.push('');
      lines.push('| Task | Due | Status |');
      lines.push('|------|-----|--------|');
      for (const task of tasks) {
        const due = task.due_at ? task.due_at.slice(0, 10) : 'No due date';
        lines.push(`| ${task.title} | ${due} | ${task.status} |`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Generated at ${new Date().toISOString()}*`);

    const markdown = lines.join('\n');

    return {
      ok: true,
      summary: `Generated brief (${markdown.length} chars, ${actions.length} actions, ${tasks.length} tasks)`,
      data: {
        markdown,
        action_count: actions.length,
        task_count: tasks.length,
      },
    };
  };
}

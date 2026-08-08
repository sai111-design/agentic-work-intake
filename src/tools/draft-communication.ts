/**
 * Tool 1 — Draft Communication
 *
 * Uses the LLM (through LLMProvider) to generate a draft email/message.
 * Never sends anything. The output is a subject + body for human review.
 *
 * recipients_resolved is always false and sent is always false — this tool
 * demonstrates AI-assisted drafting without creating unsafe side effects.
 */

import type { DraftInput, LLMProvider } from '../llm/provider.js';
import type { ToolResult } from './registry.js';

/**
 * Creates the draft_communication tool function, closed over the provider.
 * This keeps the provider injectable for tests without polluting the tool
 * signature.
 */
export function makeDraftCommunication(provider: LLMProvider) {
  return async function draftCommunication(input: Record<string, unknown>): Promise<ToolResult> {
    const recipientDescription = String(input['recipient_description'] ?? '').trim();
    const subjectHint = String(input['subject_hint'] ?? '').trim();
    const keyPoints = Array.isArray(input['key_points'])
      ? (input['key_points'] as unknown[]).map(String)
      : [];
    const context = String(input['context'] ?? '').trim();
    const tone = input['tone'] === 'friendly' ? 'friendly' as const : 'formal' as const;

    if (!recipientDescription) {
      return {
        ok: false,
        summary: 'Cannot draft a communication without a recipient.',
        data: { error: 'missing_recipient' },
      };
    }

    const draftInput: DraftInput = {
      recipient_description: recipientDescription,
      subject_hint: subjectHint || 'Follow-up',
      key_points: keyPoints.length > 0 ? keyPoints : ['Please follow up on our discussion.'],
      context: context || 'No additional context provided.',
      tone,
    };

    try {
      const draft = await provider.draftCommunication(draftInput);
      return {
        ok: true,
        summary: `Drafted message: "${draft.subject}" (${draft.body.length} chars)`,
        data: {
          subject: draft.subject,
          body: draft.body,
          recipient_description: recipientDescription,
          recipients_resolved: false,
          sent: false,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `Failed to draft communication: ${message}`,
        data: { error: message },
      };
    }
  };
}

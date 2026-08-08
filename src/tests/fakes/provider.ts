/**
 * Test double for LLMProvider.
 *
 * Every test in the default suite runs against this, which is what makes
 * `npm test` pass with no GEMINI_API_KEY and no network. It is also the second
 * implementation that justifies the LLMProvider interface existing at all.
 */

import type { Interpretation } from '../../core/schemas.js';
import { LlmError, type DraftInput, type DraftOutput, type LLMProvider, type LlmErrorCode } from '../../llm/provider.js';
import { makeInterpretation } from '../fixtures.js';

export interface FakeProviderOptions {
  /** Interpretation to return. Defaults to a minimal valid one. */
  interpretation?: Interpretation;
  /** Draft to return. */
  draft?: DraftOutput;
  /** If set, interpret() rejects with this code. */
  failInterpretWith?: LlmErrorCode;
  /** If set, draftCommunication() rejects with this code. */
  failDraftWith?: LlmErrorCode;
  configured?: boolean;
}

export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly configured: boolean;

  interpretCalls: string[] = [];
  draftCalls: DraftInput[] = [];

  constructor(private readonly options: FakeProviderOptions = {}) {
    this.configured = options.configured ?? true;
  }

  async interpret(rawText: string): Promise<Interpretation> {
    this.interpretCalls.push(rawText);
    if (this.options.failInterpretWith) {
      throw new LlmError(this.options.failInterpretWith, `fake failure: ${this.options.failInterpretWith}`);
    }
    return this.options.interpretation ?? makeInterpretation();
  }

  async draftCommunication(input: DraftInput): Promise<DraftOutput> {
    this.draftCalls.push(input);
    if (this.options.failDraftWith) {
      throw new LlmError(this.options.failDraftWith, `fake failure: ${this.options.failDraftWith}`);
    }
    return (
      this.options.draft ?? {
        subject: `Re: ${input.subject_hint}`,
        body: `Dear ${input.recipient_description},\n\n${input.key_points.join('\n')}\n\nBest regards`,
      }
    );
  }
}

/**
 * The single source of truth for the interpretation contract.
 *
 * One Zod schema serves three jobs:
 *   1. the TypeScript type used throughout the app,
 *   2. the JSON Schema sent to the model to constrain generation,
 *   3. the runtime validation of whatever actually comes back.
 *
 * CONSTRAINT PLACEMENT MATTERS. Gemini rejects schemas containing JSON Schema
 * keywords it does not support, and Zod's .min()/.max()/.email() emit exactly
 * those. So structural shape (types, enums, arrays, descriptions) is expressed
 * normally, while bounds and format rules use .refine(), which is enforced at
 * runtime but invisible to z.toJSONSchema(). See schema-to-json.ts.
 */

import { z } from 'zod';

/** Runtime-only non-empty check. Emits no JSON Schema keyword. */
const nonEmptyText = (label: string) =>
  z.string().refine((s) => s.trim().length > 0, { message: `${label} must not be empty` });

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/**
 * What kind of work an action IS — not which tool should run.
 *
 * This distinction is the core agent boundary: describing the nature of a
 * request is understanding (the model's job); deciding which tool executes is
 * policy (the planner's job). The model is never shown tool names, so it
 * cannot steer execution.
 */
export const ACTION_KINDS = [
  'communication', // write a message/email to someone
  'reminder', // track or schedule something for later
  'website_review', // inspect a web page or site
  'summary', // produce a written summary, brief, or report
  'other', // anything this system has no notion of
] as const;

export const ActionItemSchema = z.object({
  title: nonEmptyText('action title').describe(
    'Short imperative description of one discrete action, e.g. "Draft thank-you email to the partner".',
  ),
  detail: z
    .string()
    .describe('One or two sentences of context for this action, drawn only from the request text.'),
  kind: z
    .enum(ACTION_KINDS)
    .describe(
      'The nature of the work: communication (write a message), reminder (track something for later), website_review (inspect a web page), summary (produce a written document), or other.',
    ),
  recipient: z
    .string()
    .nullable()
    .describe(
      'For a communication, who it is addressed to, exactly as the request identifies them. Vague collective references such as "everyone", "the team", or "all stakeholders" are NOT a recipient — use null for those. Null for non-communication actions, or whenever the request does not say who. Never invent a recipient.',
    ),
  target_url: z
    .string()
    .nullable()
    .describe(
      'For a website_review, the URL to inspect, copied verbatim from the request. Null if the request names no URL. Never invent or complete a URL.',
    ),
  missing_information: z
    .array(z.string())
    .describe(
      'Specific facts absent from the request that are REQUIRED before this action could be carried out — e.g. "recipient email address is not specified". Empty array if nothing is missing. Never guess a value instead of listing it here.',
    ),
  due_in_days: z
    .number()
    .int()
    .nullable()
    .describe(
      'If the request states a relative deadline for this action in days (e.g. "in 7 days"), the number of days. Otherwise null. Do not infer a value that was not stated.',
    ),
  can_be_automated: z
    .boolean()
    .describe(
      'Your suggestion as to whether this could be done without a human. Advisory only — the system decides independently.',
    ),
  requires_human_confirmation: z
    .boolean()
    .describe('True if a person should review this before it takes effect.'),
});

export const InterpretationSchema = z.object({
  task_title: nonEmptyText('task_title').describe('A short title for the overall request.'),
  summary: nonEmptyText('summary').describe(
    'Two or three sentences summarising what is being asked, using only information present in the request.',
  ),
  priority: z
    .enum(PRIORITIES)
    .describe('Urgency implied by the request. Use "medium" when the request gives no signal.'),
  detected_deadline: z
    .string()
    .nullable()
    .describe(
      'Any deadline exactly as stated in the request, e.g. "before the meeting" or "within 7 days". Null if the request states none. Never invent a date.',
    ),
  action_items: z
    .array(ActionItemSchema)
    .describe('Each discrete piece of work the request asks for.'),
  missing_information: z
    .array(z.string())
    .describe(
      'Request-level facts that are absent and would be needed to act — e.g. "which meeting is referred to". Empty array if nothing is missing.',
    ),
  what_can_be_automated: z
    .array(z.string())
    .describe('Plain-language list of the parts that appear automatable. Advisory only.'),
  what_requires_human_confirmation: z
    .array(z.string())
    .describe('Plain-language list of the parts a person should approve before they take effect.'),
});

export type ActionItem = z.infer<typeof ActionItemSchema>;
export type Interpretation = z.infer<typeof InterpretationSchema>;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type Priority = (typeof PRIORITIES)[number];

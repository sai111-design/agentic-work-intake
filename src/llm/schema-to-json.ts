/**
 * Zod -> JSON Schema, reduced to the subset Gemini accepts.
 *
 * Gemini's structured-output schema is a subset of the OpenAPI 3.0 schema
 * object and rejects keywords outside it. z.toJSONSchema() emits several that
 * are not in that subset, some of them surprising:
 *
 *   - `$schema`             — JSON Schema metadata
 *   - `additionalProperties`— not part of the accepted subset
 *   - `minimum` / `maximum` — Zod adds safe-integer bounds to EVERY .int(),
 *                             even when no bound was asked for
 *
 * Rather than chase a blocklist of everything Zod might emit next release,
 * this keeps an allowlist of the keywords we actually rely on. Anything new
 * is dropped by default, which fails safe.
 *
 * Dropping `additionalProperties` costs nothing: Zod objects strip unknown
 * keys at parse time, so extra fields from the model are discarded anyway.
 */

import { z } from 'zod';
import { InterpretationSchema } from '../core/schemas.js';
import { DraftSchema } from './provider.js';

/** JSON Schema keywords Gemini is known to accept and that we depend on. */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'anyOf',
  'nullable',
]);

/** Keys whose values are subschemas and must be recursed into. */
const SUBSCHEMA_KEYS = new Set(['items', 'anyOf']);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (!ALLOWED_KEYWORDS.has(key)) continue;

    if (key === 'properties') {
      // Keys here are arbitrary property NAMES, not keywords — recurse into
      // the values only, never filter the names.
      const props: Record<string, unknown> = {};
      for (const [name, subSchema] of Object.entries(value as Record<string, unknown>)) {
        props[name] = sanitize(subSchema);
      }
      out[key] = props;
    } else if (SUBSCHEMA_KEYS.has(key)) {
      out[key] = sanitize(value);
    } else {
      // type / required / enum / description / nullable — plain values.
      out[key] = value;
    }
  }

  return out;
}

export function toGeminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' });
  return sanitize(raw) as Record<string, unknown>;
}

/**
 * Built once at module load, not per request — the schema never varies, and
 * regenerating it on every call would be pure waste.
 */
export const interpretationJsonSchema = toGeminiJsonSchema(InterpretationSchema);

/** Schema for the drafting call, built once for the same reason. */
export const draftJsonSchema = toGeminiJsonSchema(DraftSchema);

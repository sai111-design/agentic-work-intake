# Gemini SDK verification spike

Run before any adapter code was written, because two documentation sources
disagreed on both the structured-output shape and the response accessor.
Everything below was confirmed against the **installed** package
(`@google/genai@2.16.0`) and live API calls — not from documentation.

Re-run the live half at any time with `npm run test:live`.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Model accepted | ⚠️ **`gemini-2.5-flash` FAILS** — see below. Using `gemini-3.5-flash`. |
| 2 | `ai.interactions.create(...)` exists | ✅ `GeminiNextGenInteractions.create(params, options?)`, reached via `ai.interactions` |
| 3 | `response_format` shape | ✅ `Array<ResponseFormat> \| ResponseFormat`. Text variant: `{ type: 'text', mime_type, schema }` |
| 4 | Output accessor | ✅ `interaction.output_text` — but **optional** (`string \| undefined`) |
| 5 | Schema-constrained JSON works | ✅ Valid against `InterpretationSchema` on all three scenarios |
| 6 | Timeout / AbortSignal | ✅ `httpOptions.timeout` (ms) and `abortSignal` per request |
| 7 | Internal retry behaviour | ⚠️ **Retries 5× by default** on 408/429/5xx — see below |

## Findings that changed the implementation

### 1. `gemini-2.5-flash` is unavailable to newer accounts

The originally specified model returns:

```
404  This model models/gemini-2.5-flash is no longer available to new users.
```

Critically, **`models.list()` still advertises it** — only a real generation
call reveals the problem. Listing is not a reliable availability signal.

Measured alternatives, all returning schema-valid output:

| Model | Latency (interpretation) | Notes |
|---|---|---|
| **`gemini-3.5-flash`** | **~6 s** | **Chosen default** — fastest, correct on all three scenarios |
| `gemini-3.1-flash-lite` | ~8 s | Works |
| `gemini-3.6-flash` | ~18 s | Works; slower |
| `gemini-flash-latest` | ~26 s | Rejects `thinking_level: minimal` |
| `gemini-2.0-flash` | — | 500 Internal error |
| `gemini-2.5-flash` | — | 404, unavailable to new users |

Override with `GEMINI_MODEL` in `.env`.

### 2. Thinking is on by default and dominated latency

Gemini 3.x models think by default. On the identical request and schema:

| `generation_config.thinking_level` | Latency |
|---|---|
| *(unset — default)* | **64.6 s** |
| `low` | 14.4 s |
| `minimal` | **12.7 s** |

Same measurement on `gemini-3.5-flash` gives ~6 s at `minimal`, and output
stayed schema-valid throughout. The adapter sets `thinking_level: 'minimal'`:
extraction is a reading task, not a reasoning one. This single line is the
difference between a usable demo and one that looks hung.

### 3. `err instanceof ApiError` is FALSE for real SDK errors

The SDK throws subclasses (`NotFoundError`, `BadRequestError`,
`InternalServerError`) that carry a numeric `status` but do **not** satisfy
`instanceof ApiError`. The first version of `mapError()` used that class check
and therefore collapsed every failure into a generic "could not reach Gemini",
hiding the 404 that explained the real problem.

`mapError()` now duck-types on `status` and includes the provider's own message
in the trace.

### 4. The SDK already retries — the app must not

`HttpRetryOptions`: *"Maximum number of attempts, including the original. If 0
or 1, it means no retries. If not specified, default to 5."* — retrying
408/429/5xx with exponential backoff up to 60 s.

So an application-level transport retry would have produced **10 attempts** and
a demo stalling for minutes. The adapter therefore adds **zero** transport
retries and lowers the SDK's own to `attempts: 2`. The only application-level
retry is the single *validation* retry, which is a different failure class.

### 5. Zod emits JSON Schema keywords Gemini rejects

`z.toJSONSchema()` produced `$schema`, `additionalProperties`, and — from
`z.number().int()` — `minimum: -9007199254740991, maximum: 9007199254740991`,
safe-integer bounds nobody asked for.

`schema-to-json.ts` reduces the output to an allowlist of the keywords actually
needed. Confirmed working: `.refine()` constraints emit **no** JSON Schema
keyword, so runtime bounds stay out of the wire schema as designed.

## Confirmed call

```ts
const interaction = await ai.interactions.create({
  model: config.geminiModel,              // 'gemini-3.5-flash'
  input: rawText,
  system_instruction: INTERPRETER_SYSTEM_PROMPT,
  generation_config: { thinking_level: 'minimal' },
  response_format: {
    type: 'text',
    mime_type: 'application/json',
    schema: interpretationJsonSchema,
  },
});

const rawJson = interaction.output_text;  // optional — absence is a real failure
```

Client construction:

```ts
new GoogleGenAI({
  apiKey: config.geminiApiKey,
  httpOptions: { timeout: 30_000, retryOptions: { attempts: 2 } },
});
```

## Prompt iteration (also part of this phase)

The first working version over-blocked. On Scenario 1 the model listed
"transcript of the partner discussion" and "contact details of the partner" as
missing information, so **all four actions were routed to clarification** and
the approval step vanished from the demo.

The cause was conflating two different things under one field: facts that make
an action *impossible*, and context that would merely make it *better*. The
prompt and schema description now apply an explicit test — *could a competent
assistant still produce something useful for a human to review without this?* —
with drafting and reminder-recording always answering yes, and analysing
never-provided content answering no.

Resulting routing, measured end-to-end through the real planner:

| Scenario | Outcome |
|---|---|
| 1 — routine work | `PLAN_READY`: summary → clarification, email → **approval**, reminder → **auto** |
| 2 — website review | `PLAN_READY`: site check → **auto**, report → approval |
| 3 — ambiguous | `NEEDS_CLARIFICATION`, nothing executed, no recipient invented |

Scenario 1 exercising three different classifications at once is a better
demonstration than everything succeeding.

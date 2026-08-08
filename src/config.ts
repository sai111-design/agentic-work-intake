/**
 * Single place where environment becomes typed config.
 * Nothing else in the app reads process.env.
 */

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  dbPath: process.env.DB_PATH ?? './data/app.db',
  port: Number(process.env.PORT ?? 3000),
} as const;

/**
 * Whether an API key is present. Deliberately a boolean — the key itself must
 * never leave this module, and /api/health reports only this.
 */
export function isLlmConfigured(): boolean {
  return config.geminiApiKey.trim().length > 0;
}

/** Hard cap on submitted text. Bounds prompt cost and DB row size. */
export const MAX_REQUEST_CHARS = 20_000;

import { z } from 'zod';

export class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiResponseError';
  }
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const candidates = [withoutFence];
  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  throw new AiResponseError('The AI response did not contain valid JSON.');
}

export function parseWithSchema<T>(text: string, schema: z.ZodType<T>): T {
  const json = extractJsonObject(text);
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AiResponseError(
      issue ? `The AI response was missing or had an invalid "${issue.path.join('.')}": ${issue.message}` : 'The AI response had an unexpected shape.',
    );
  }
  return result.data;
}

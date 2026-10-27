import { z } from 'zod';

export class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiResponseError';
  }
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/** Pull the first top-level `{...}` while respecting JSON strings. */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function removeTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, '$1');
}

function tryParse(candidate: string): unknown | undefined {
  const cleaned = removeTrailingCommas(candidate.trim());
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort close of a truncated JSON object so partial model output can still parse.
 * Only used as a last resort after balanced extraction fails.
 */
function repairTruncatedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let body = text.slice(start);
  let inString = false;
  let escape = false;
  let depth = 0;
  const stack: Array<'{' | '['> = [];

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      stack.push('{');
    } else if (ch === '[') {
      stack.push('[');
    } else if (ch === '}') {
      depth -= 1;
      if (stack.at(-1) === '{') stack.pop();
    } else if (ch === ']') {
      if (stack.at(-1) === '[') stack.pop();
    }
  }

  if (!stack.length && !inString) return null;

  let repaired = body.replace(/,\s*$/, '');
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');
  while (stack.length) {
    const open = stack.pop();
    repaired += open === '[' ? ']' : '}';
  }
  return repaired;
}

export function extractJsonObject(text: string): unknown {
  const withoutFence = stripCodeFences(stripBom(text));
  const candidates: string[] = [withoutFence];

  const balanced = extractBalancedObject(withoutFence);
  if (balanced) candidates.push(balanced);

  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));
  }

  const repaired = repairTruncatedObject(withoutFence);
  if (repaired) candidates.push(repaired);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
  }

  const preview = withoutFence.replace(/\s+/g, ' ').slice(0, 180);
  throw new AiResponseError(
    preview
      ? `The AI response did not contain valid JSON. Preview: ${preview}`
      : 'The AI response did not contain valid JSON.',
  );
}

export function parseWithSchema<T>(text: string, schema: z.ZodType<T>): T {
  const json = extractJsonObject(text);
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AiResponseError(
      issue
        ? `The AI response was missing or had an invalid "${issue.path.join('.')}": ${issue.message}`
        : 'The AI response had an unexpected shape.',
    );
  }
  return result.data;
}

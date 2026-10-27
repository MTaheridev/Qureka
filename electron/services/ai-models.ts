import type { AiModelInput, AiModelView, AiProtocol, AiTestResult } from '../../shared/ipc';
import { getPrisma } from '../db/client';
import { testConnection, type AiConfig } from '../ai/client';
import { decryptSecret, encryptSecret } from './secrets';

function normalizeInput(input: AiModelInput): {
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
} {
  const name = String(input.name ?? '').trim();
  const protocol = input.protocol === 'anthropic' ? 'anthropic' : input.protocol === 'openai' ? 'openai' : null;
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(input.model ?? '').trim();
  const apiKey = String(input.apiKey ?? '').trim();

  if (!name) throw new Error('Give the AI model a name.');
  if (name.length > 120) throw new Error('The AI model name is too long.');
  if (!protocol) throw new Error('Choose an OpenAI-compatible or Anthropic-compatible protocol.');
  if (!baseUrl) throw new Error('Enter the AI provider base URL.');
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error('The AI provider base URL must start with http:// or https://.');
  }
  if (!model) throw new Error('Enter the model name.');

  return { name, protocol, baseUrl, model, apiKey };
}

function toView(row: {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  createdAt: Date;
}): AiModelView {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: row.baseUrl,
    model: row.model,
    hasApiKey: Boolean(row.apiKey),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAiModels(): Promise<AiModelView[]> {
  const prisma = getPrisma();
  const rows = await prisma.aiModel.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(toView);
}

export async function createAiModel(input: AiModelInput): Promise<AiModelView> {
  const normalized = normalizeInput(input);
  if (!normalized.apiKey) throw new Error('Enter the API key.');

  const prisma = getPrisma();
  const row = await prisma.aiModel.create({
    data: {
      name: normalized.name,
      protocol: normalized.protocol,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      apiKey: encryptSecret(normalized.apiKey) ?? '',
    },
  });
  return toView(row);
}

export async function updateAiModel(id: string, input: AiModelInput): Promise<AiModelView> {
  const normalized = normalizeInput(input);
  const prisma = getPrisma();
  const existing = await prisma.aiModel.findUnique({ where: { id } });
  if (!existing) throw new Error('This AI model no longer exists.');

  const row = await prisma.aiModel.update({
    where: { id },
    data: {
      name: normalized.name,
      protocol: normalized.protocol,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      ...(normalized.apiKey ? { apiKey: encryptSecret(normalized.apiKey) ?? '' } : {}),
    },
  });
  return toView(row);
}

export async function removeAiModel(id: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.aiModel.delete({ where: { id } });
}

export async function testAiModel(input: AiModelInput, savedId?: string): Promise<AiTestResult> {
  const normalized = normalizeInput(input);
  let apiKey = normalized.apiKey;

  if (!apiKey && savedId) {
    const prisma = getPrisma();
    const existing = await prisma.aiModel.findUnique({ where: { id: savedId } });
    apiKey = decryptSecret(existing?.apiKey) ?? '';
  }

  if (!apiKey) {
    return { ok: false, message: 'Enter an API key before testing the model.', latencyMs: 0 };
  }

  const config: AiConfig = {
    protocol: normalized.protocol,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    apiKey,
  };
  return testConnection(config);
}

export async function resolveAiConfig(modelId: string | null | undefined): Promise<AiConfig> {
  if (!modelId) {
    throw new Error('Select an AI model for this connection first.');
  }
  const prisma = getPrisma();
  const row = await prisma.aiModel.findUnique({ where: { id: modelId } });
  if (!row) {
    throw new Error('The selected AI model no longer exists.');
  }
  const apiKey = decryptSecret(row.apiKey);
  if (!apiKey) {
    throw new Error('The API key for the selected AI model cannot be read. Please enter it again.');
  }
  return {
    protocol: row.protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey,
  };
}

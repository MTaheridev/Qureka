#!/usr/bin/env node
/**
 * Upserts an OpenRouter AI model into the local EasyReporter SQLite DB.
 * Reads OPENROUTER_* from .env (never commit real keys).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.resolve('.env'));

const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
const model = (process.env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it').trim();
const baseUrl = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
const name = 'OpenRouter Gemma';

if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY in .env first.');
  process.exit(1);
}

const encoded = `er:v1:b64:${Buffer.from(apiKey, 'utf8').toString('base64')}`;
const id = `or_${crypto.createHash('sha256').update(`${baseUrl}|${model}`).digest('hex').slice(0, 24)}`;
const now = new Date().toISOString();

const dbFile = path.resolve('prisma/easy-reporter.db');
const client = createClient({ url: `file:${dbFile}` });

(async () => {
  const existing = await client.execute({
    sql: `SELECT id FROM AiModel
          WHERE baseUrl = ? OR name = ? OR model LIKE 'google/gemma-4-26b-a4b-it%'
          ORDER BY createdAt ASC LIMIT 1`,
    args: [baseUrl, name],
  });

  if (existing.rows.length > 0) {
    const rowId = existing.rows[0].id;
    await client.execute({
      sql: 'UPDATE AiModel SET name = ?, protocol = ?, baseUrl = ?, model = ?, apiKey = ?, updatedAt = ? WHERE id = ?',
      args: [name, 'openai', baseUrl, model, encoded, now, rowId],
    });
    console.log(`updated model ${rowId}`);
  } else {
    await client.execute({
      sql: 'INSERT INTO AiModel (id, name, protocol, baseUrl, model, apiKey, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, name, 'openai', baseUrl, model, encoded, now, now],
    });
    console.log(`created model ${id}`);
  }

  const models = await client.execute({
    sql: 'SELECT id FROM AiModel WHERE baseUrl = ? AND model = ? LIMIT 1',
    args: [baseUrl, model],
  });
  const modelId = models.rows[0]?.id;
  if (modelId) {
    await client.execute({
      sql: 'UPDATE DbConnection SET aiModelId = ?, updatedAt = ?',
      args: [modelId, now],
    });
    console.log(`connections pointed at ${modelId}`);
  }

  const list = await client.execute('SELECT id, name, protocol, baseUrl, model FROM AiModel ORDER BY createdAt');
  console.log(JSON.stringify(list.rows, null, 2));
  client.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

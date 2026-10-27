#!/usr/bin/env node
/**
 * Upserts an AvalAI AI model into the local EasyReporter SQLite DB.
 * Reads AVALAI_* from .env (never commit real keys).
 * Docs: https://docs.avalai.ir/fa/quickstart
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

const apiKey = (process.env.AVALAI_API_KEY || '').trim();
const model = (process.env.AVALAI_MODEL || 'claude-haiku-5-5').trim();
const baseUrl = (process.env.AVALAI_BASE_URL || 'https://api.avalai.ir/v1').trim().replace(/\/+$/, '');
const name = 'AvalAI Claude Haiku';

if (!apiKey) {
  console.error('Set AVALAI_API_KEY in .env first.');
  process.exit(1);
}

const encoded = `er:v1:b64:${Buffer.from(apiKey, 'utf8').toString('base64')}`;
const id = `avalai_${crypto.createHash('sha256').update(`${baseUrl}|${model}`).digest('hex').slice(0, 24)}`;
const now = new Date().toISOString();

const dbFile = path.resolve('prisma/easy-reporter.db');
const client = createClient({ url: `file:${dbFile}` });

(async () => {
  const existing = await client.execute({
    sql: `SELECT id FROM AiModel
          WHERE baseUrl LIKE '%avalai.ir%' OR name LIKE '%AvalAI%' OR name LIKE '%OpenRouter%'
          ORDER BY createdAt ASC LIMIT 1`,
    args: [],
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

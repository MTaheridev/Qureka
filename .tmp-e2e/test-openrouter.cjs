#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.resolve('.env'));

const key = process.env.OPENROUTER_API_KEY;
const models = [
  'google/gemma-4-26b-a4b-it',
  'google/gemma-4-26b-a4b-it:free',
];

async function tryOnce(model, body) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://taheri.vercel.app',
      'X-Title': 'EasyReporter',
    },
    body: JSON.stringify({ model, ...body }),
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 500) };
}

(async () => {
  if (!key) {
    console.error('missing OPENROUTER_API_KEY');
    process.exit(1);
  }
  for (const model of models) {
    console.log('\n===', model, 'with system ===');
    console.log(await tryOnce(model, {
      max_tokens: 32,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Reply with the single word OK.' },
        { role: 'user', content: 'Reply with the single word OK.' },
      ],
    }));
    console.log('\n===', model, 'user only ===');
    console.log(await tryOnce(model, {
      max_tokens: 32,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    }));
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

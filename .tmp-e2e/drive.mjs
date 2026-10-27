import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('.tmp-e2e/shots');
fs.mkdirSync(OUT, { recursive: true });

let target;
for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/list');
    const list = await res.json();
    target = list.find((item) => item.type === 'page' && item.url.includes('index.html'));
  } catch {
    // Electron may not be listening yet.
  }
  if (!target) await new Promise((r) => setTimeout(r, 250));
}
if (!target) throw new Error('Could not find the EasyReporter page target.');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const payload = JSON.parse(event.data);
  if (payload.id && pending.has(payload.id)) {
    const { resolve, reject } = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) reject(new Error(`${payload.error.message} (${payload.error.code})`));
    else resolve(payload.result);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || 'Evaluation failed');
  }
  return result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForText(text, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = await evaluate(`document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`);
    if (found) return;
    await sleep(200);
  }
  const body = await evaluate('document.body ? document.body.innerText.slice(0, 4000) : ""');
  throw new Error(`Timed out waiting for text: ${text}\n--- body ---\n${body}`);
}

async function waitForGone(text, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = await evaluate(`document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`);
    if (!found) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for text to disappear: ${text}`);
}

async function click(text, selector = 'button') {
  const ok = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const node = nodes.find((candidate) => norm(candidate.textContent).includes(${JSON.stringify(text)}));
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (!ok) throw new Error(`Click target not found: ${text}`);
}

async function clickNth(text, index, selector = 'button') {
  const ok = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const matches = nodes.filter((candidate) => norm(candidate.textContent).includes(${JSON.stringify(text)}));
    if (!matches[${index}]) return false;
    matches[${index}].click();
    return true;
  })()`);
  if (!ok) throw new Error(`Click target not found at index ${index}: ${text}`);
}


async function clickSelector(selector) {
  const ok = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (!ok) throw new Error(`Click target not found: ${selector}`);
}

async function setField(label, value, tag = 'input') {
  const ok = await evaluate(`(() => {
    const labelText = ${JSON.stringify(label)};
    const field = [...document.querySelectorAll('.field')].find(
      (candidate) => (candidate.querySelector(':scope > span')?.textContent || '').trim() === labelText,
    );
    if (!field) return 'no-field';
    const el = field.querySelector(${JSON.stringify(tag)});
    if (!el) return 'no-element';
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return 'ok';
  })()`);
  if (ok !== 'ok') throw new Error(`Could not set field "${label}": ${ok}`);
}

async function setElement(selector, value, index = 0) {
  const ok = await evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return 'no-element';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  if (ok !== 'ok') throw new Error(`Could not set ${selector}[${index}]: ${ok}`);
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  console.log(`shot ${name}`);
}

async function main() {
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.reload');
  await sleep(1500);
  await waitForText('Connections');
  await waitForText('New connection');
  await shot('01-connections-empty');

  console.log('→ AI models');
  await click('AI models', 'button.nav-item');
  await click('Add model');
  await waitForText('Protocol');

  await setField('Name', 'Mock analyst');
  await setField('Model', 'mock-model');
  await setField('Base URL', 'http://127.0.0.1:4599/v1');
  await setField('API key', 'test-key');

  await click('Test connection');
  await waitForText('Connected.');
  await shot('02-model-form');

  await clickSelector('.form-actions button.primary');
  await waitForGone('New AI model');
  await waitForText('Mock analyst');
  await shot('03-models-list');

  console.log('→ connection');
  await click('Connections', 'button.nav-item');
  await waitForText('New connection');
  await click('New connection');
  await waitForText('New database connection');

  await setField('Name', 'Sample store');
  await click('SQLite');
  await sleep(200);
  await setField('Database file', path.resolve('.tmp-e2e/sample.db'));
  await shot('04-connection-form');

  await click('Verify read-only');
  await waitForText('Overview', 30000);
  await waitForText('Sample store');
  await shot('05-overview');

  console.log('→ onboarding');
  await click('Setup', 'button.tab');
  await waitForText('Generate questions');
  await click('Generate questions');
  await waitForText('Onboarding questions', 30000);
  await waitForText('Q10');

  const answers = [
    'Yes, exactly those four statuses.',
    'Yes, refunded orders are excluded from revenue.',
    'It is the price captured at purchase time.',
  ];
  for (let i = 0; i < answers.length; i += 1) {
    await setElement('.question textarea', answers[i], i);
  }
  await sleep(300);
  for (let i = 0; i < answers.length; i += 1) {
    await clickNth('Save answer', i);
    await sleep(400);
  }
  await waitForText('3 of 10 answered');
  await shot('06-setup-answered');

  console.log('→ knowledge base');
  await click('Build knowledge base');
  await waitForText('The knowledge base is ready', 30000);
  await shot('07-knowledge-built');

  await click('View knowledge base');
  await waitForText('Revenue', 15000);
  await shot('08-knowledge-panel');

  console.log('→ chat');
  await click('Chat', 'button.tab');
  await waitForText('How many');
  await sleep(500);
  await shot('09-chat-empty');

  await setElement('textarea', 'How many customers are there?', 0);
  await sleep(200);
  await clickSelector('button.send');
  await waitForText('Answer:', 30000);
  await waitForText('total_customers: 12', 30000);
  await shot('10-chat-single-row');

  await setElement('textarea', 'Who are the top 5 customers by revenue?', 0);
  await sleep(200);
  await clickSelector('button.send');
  await waitForText('Noah Silva', 30000);
  await waitForText('5 rows', 30000);
  await shot('11-chat-table');

  console.log('→ manual SQL + write guard');
  await click('Run SQL manually');
  await waitForText('SQL editor');
  await setElement('.manual-sql textarea', 'DELETE FROM customers', 0);
  await sleep(200);
  await click('Run query', 'button.primary');
  await waitForText('read-only', 20000);
  await shot('12-guard-rejected');

  await setElement('.manual-sql textarea', "SELECT name, country FROM customers WHERE country = 'DE' ORDER BY name", 0);
  await sleep(200);
  await click('Run query', 'button.primary');
  await waitForText('Query executed from the SQL editor.', 20000);
  await shot('13-manual-run');

  console.log('DONE');
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(`FAILED: ${error.message}`);
    try {
      await shot('99-failure');
    } catch {
      // Ignore screenshot failures.
    }
    process.exit(1);
  });

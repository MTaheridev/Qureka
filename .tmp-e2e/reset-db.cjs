const { createClient } = require('@libsql/client');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const file = path.resolve('prisma/easy-reporter.db');
const client = createClient({ url: `file:${file}` });
const tables = ['QueryRun', 'Message', 'Conversation', 'KnowledgeBase', 'OnboardingQuestion', 'DbConnection', 'AiModel'];

(async () => {
  for (const table of tables) {
    await client.execute(`DELETE FROM "${table}"`);
  }
  console.log('cleared:', tables.join(', '));
  client.close();

  const runs = path.join(os.homedir(), '.config', 'EasyReporter', 'runs');
  if (fs.existsSync(runs)) {
    const files = fs.readdirSync(runs);
    for (const name of files) fs.rmSync(path.join(runs, name), { force: true });
    console.log(`cleared runs: ${files.length}`);
  }
})().catch((error) => { console.error(error); process.exit(1); });

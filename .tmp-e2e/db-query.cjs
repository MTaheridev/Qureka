const { createClient } = require('@libsql/client');
const path = require('node:path');
const file = path.resolve(process.argv[2] || 'prisma/easy-reporter.db');
const client = createClient({ url: `file:${file}` });
const sql = process.argv[3];
(async () => {
  const result = await client.execute(sql);
  console.log(JSON.stringify(result.rows, (k, v) => typeof v === 'bigint' ? Number(v) : v, 2));
  client.close();
})().catch((e) => { console.error(e.message); process.exit(1); });

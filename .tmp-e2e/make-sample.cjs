const { createClient } = require('@libsql/client');
const path = require('node:path');
const fs = require('node:fs');

const file = path.resolve('.tmp-e2e/sample.db');
fs.rmSync(file, { force: true });
const client = createClient({ url: `file:${file}` });

const firstNames = ['Ava', 'Liam', 'Noah', 'Emma', 'Olivia', 'Mateo', 'Sofia', 'Ethan', 'Mia', 'Lucas', 'Amara', 'Hugo'];
const lastNames = ['Bennett', 'Okafor', 'Silva', 'Novak', 'Haddad', 'Kowalski', 'Fischer', 'Rossi', 'Tanaka', 'Mensah', 'Dupont', 'Larsen'];
const countries = ['US', 'DE', 'BR', 'CA', 'FR', 'JP', 'GH', 'PL', 'IT', 'NL'];
const products = [
  ['Cedar Desk', 'Furniture', 480.0],
  ['Ergo Chair', 'Furniture', 320.0],
  ['Lumen Lamp', 'Lighting', 89.5],
  ['Oak Shelf', 'Furniture', 210.0],
  ['Arc Monitor', 'Electronics', 640.0],
  ['Quiet Keyboard', 'Electronics', 145.0],
  ['Wool Rug', 'Textiles', 260.0],
  ['Brass Clock', 'Decor', 75.0],
];
const statuses = ['paid', 'paid', 'paid', 'pending', 'refunded', 'shipped'];

const statements = [
  `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, country TEXT NOT NULL, created_at TEXT NOT NULL);`,
  `CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit_price REAL NOT NULL);`,
  `CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), ordered_at TEXT NOT NULL, status TEXT NOT NULL);`,
  `CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL, unit_price REAL NOT NULL);`,
];

for (let i = 0; i < firstNames.length; i += 1) {
  const name = `${firstNames[i]} ${lastNames[i]}`;
  statements.push(
    `INSERT INTO customers VALUES (${i + 1}, '${name}', '${firstNames[i].toLowerCase()}.${lastNames[i].toLowerCase()}@example.com', '${countries[i % countries.length]}', '2025-0${(i % 8) + 1}-1${i % 9}');`,
  );
}

products.forEach(([name, category, price], index) => {
  statements.push(`INSERT INTO products VALUES (${index + 1}, '${name}', '${category}', ${price});`);
});

let itemId = 0;
for (let orderId = 1; orderId <= 30; orderId += 1) {
  const customerId = ((orderId * 7) % 12) + 1;
  const month = String(((orderId - 1) % 9) + 1).padStart(2, '0');
  const day = String(((orderId * 3) % 27) + 1).padStart(2, '0');
  const status = statuses[orderId % statuses.length];
  statements.push(`INSERT INTO orders VALUES (${orderId}, ${customerId}, '2026-${month}-${day}', '${status}');`);
  const lineCount = (orderId % 3) + 1;
  for (let line = 0; line < lineCount; line += 1) {
    itemId += 1;
    const productIndex = (orderId + line) % products.length;
    const quantity = ((orderId + line) % 4) + 1;
    statements.push(
      `INSERT INTO order_items VALUES (${itemId}, ${orderId}, ${productIndex + 1}, ${quantity}, ${products[productIndex][2]});`,
    );
  }
}

(async () => {
  await client.executeMultiple(statements.join('\n'));
  const counts = await Promise.all(
    ['customers', 'products', 'orders', 'order_items'].map(async (table) => {
      const result = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`);
      return `${table}=${result.rows[0].n}`;
    }),
  );
  console.log(counts.join(' '));
  client.close();
})().catch((error) => { console.error(error); process.exit(1); });

const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.MOCK_AI_PORT || 4599);
const LOG = '.tmp-e2e/mock-ai.log';

const QUESTIONS = [
  'Does the orders.status column use these exact values: paid, pending, refunded, shipped?',
  'Should refunded orders be excluded from revenue calculations?',
  'Is order_items.unit_price the price at the time of purchase, or the current product price?',
  'What does one row in the orders table represent: one order, or one order line?',
  'Is customers.country the billing country or the shipping country?',
  'Are orders without matching order_items possible in this dataset?',
  'Should revenue be calculated as quantity multiplied by unit_price?',
  'Are all monetary values stored in USD?',
  'Does the products.category column group products into a fixed set of categories?',
  'Is orders.ordered_at stored in UTC?',
].map((question) => question.replace('{', '(').replace('}', ')'));

const KNOWLEDGE = {
  summary:
    'This database is a small furniture and home-goods store. Customers place orders, and each order contains one or more order items referencing products. Revenue is the sum of quantity multiplied by the unit price captured on the order item.',
  content: [
    '## Overview',
    'The schema models a retail store with four tables: customers, products, orders and order_items.',
    '',
    '## Entities and grain',
    '- `customers`: one row per customer.',
    '- `products`: one row per sellable product.',
    '- `orders`: one row per order, placed by exactly one customer.',
    '- `order_items`: one row per product line inside an order.',
    '',
    '## Relationships and join paths',
    '`orders.customer_id` references `customers.id`. `order_items.order_id` references `orders.id`, and `order_items.product_id` references `products.id`. Revenue flows through `order_items`.',
    '',
    '## Metrics and calculations',
    '- Revenue = `SUM(order_items.quantity * order_items.unit_price)`.',
    '- Refunded orders should be excluded from revenue.',
    '',
    '## Status/filter conventions',
    '`orders.status` holds `paid`, `pending`, `refunded` or `shipped`.',
    '',
    '## Date and time handling',
    '`orders.ordered_at` and `customers.created_at` are ISO dates in UTC.',
    '',
    '## Known ambiguities',
    'The country stored on the customer is treated as the billing country.',
  ].join('\n'),
  glossary: [
    { term: 'Revenue', definition: 'Sum of quantity times unit price on order items, excluding refunded orders.' },
    { term: 'AOV', definition: 'Average order value: total revenue divided by the number of non-refunded orders.' },
  ],
  tables: [
    { schema: '', name: 'customers', description: 'One row per customer.', columns: { country: 'Billing country code.' } },
    { schema: '', name: 'orders', description: 'One row per order.', columns: { status: 'paid, pending, refunded or shipped.' } },
    { schema: '', name: 'order_items', description: 'One row per product line in an order.', columns: { unit_price: 'Price at purchase time.' } },
    { schema: '', name: 'products', description: 'One row per product.', columns: {} },
  ],
};

function log(line) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

function sqlFor(question) {
  const text = question.toLowerCase();
  if (/how many customers|count.*customer|number of customers/.test(text)) {
    return {
      sql: 'SELECT COUNT(*) AS total_customers FROM customers',
      explanation: 'Counts every row in the customers table.',
      title: 'Customer count',
    };
  }
  if (/top|best|most/.test(text) && /customer/.test(text)) {
    return {
      sql: [
        'SELECT c.name AS customer,',
        '       ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue,',
        '       COUNT(DISTINCT o.id) AS orders',
        'FROM customers c',
        'JOIN orders o ON o.customer_id = c.id',
        'JOIN order_items oi ON oi.order_id = o.id',
        "WHERE o.status <> 'refunded'",
        'GROUP BY c.id, c.name',
        'ORDER BY revenue DESC',
        'LIMIT 5',
      ].join('\n'),
      explanation: 'Joins customers to orders and order items, excludes refunded orders and ranks by revenue.',
      title: 'Top customers by revenue',
    };
  }
  if (/country/.test(text)) {
    return {
      sql: [
        'SELECT c.country AS country,',
        '       COUNT(DISTINCT o.id) AS orders,',
        '       ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue',
        'FROM customers c',
        'JOIN orders o ON o.customer_id = c.id',
        'JOIN order_items oi ON oi.order_id = o.id',
        'GROUP BY c.country',
        'ORDER BY revenue DESC',
      ].join('\n'),
      explanation: 'Groups revenue and order counts by customer country.',
      title: 'Revenue by country',
    };
  }
  return {
    sql: 'SELECT o.id AS order_id, o.ordered_at, o.status, c.name AS customer FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.ordered_at DESC LIMIT 10',
    explanation: 'Returns the ten most recent orders with their customer.',
    title: 'Recent orders',
  };
}

function completion(messages) {
  const text = messages.map((message) => String(message.content || '')).join('\n');
  if (/Reply with the single word OK/i.test(text) && /connection test/i.test(text)) {
    return 'OK';
  }
  if (/Create between 10 and 50 onboarding questions/i.test(text)) {
    return JSON.stringify({ questions: QUESTIONS });
  }
  if (/Build a structured knowledge base/i.test(text)) {
    return JSON.stringify(KNOWLEDGE);
  }
  if (/The previous query failed/i.test(text)) {
    return JSON.stringify({
      sql: 'SELECT COUNT(*) AS total_customers FROM customers',
      explanation: 'Rewrote the query using only existing columns.',
      title: 'Customer count',
    });
  }
  if (/Write one read-only SQL query/i.test(text)) {
    const match = text.match(/User request:\s*([^\n]+)/);
    return JSON.stringify(sqlFor(match ? match[1] : 'recent orders'));
  }
  return 'OK';
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    log(`${req.method} ${req.url} model=${payload.model || '-'} bytes=${body.length}`);

    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const reply = completion(payload.messages || []);
    log(`  reply ${reply.slice(0, 120).replace(/\n/g, ' ')}`);

    setTimeout(() => {
      if (/\/messages$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: reply }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: payload.model || 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
    }, 60);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  console.log(`mock AI listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

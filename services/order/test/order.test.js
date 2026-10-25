const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let server, base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const get = (path, uid) => fetch(base + path, { headers: uid ? { 'X-User-Id': uid } : {} });

test('GET /orders without X-User-Id -> 401', async () => {
  assert.equal((await get('/orders')).status, 401);
});

test('GET /orders returns only the caller\'s orders', async () => {
  const alice = await (await get('/orders', '1')).json();
  assert.deepEqual(alice.map((o) => o.id), ['o1', 'o2']);
  const bob = await (await get('/orders', '2')).json();
  assert.deepEqual(bob.map((o) => o.id), ['o3']);
});

test('GET /orders for a user with no orders -> empty list, not an error', async () => {
  const res = await get('/orders', '999');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('GET /orders/:id enforces ownership (403) and existence (404)', async () => {
  assert.equal((await get('/orders/o1', '1')).status, 200);
  assert.equal((await get('/orders/o3', '1')).status, 403);
  assert.equal((await get('/orders/nope', '1')).status, 404);
});

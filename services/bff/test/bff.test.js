const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createApp } = require('../server');

const SECRET = 'test-secret';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((r) => server.close(r));

// Upstream gia lap; ghi lai header nhan duoc.
function stub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    handler(req, res);
  });
  return { server, seen };
}
const json = (body) => (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

async function withApp(opts, fn) {
  const server = createApp({ jwtSecret: SECRET, timeoutMs: 500, ...opts }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await close(server);
  }
}

// ---- /auth/verify ----
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const verify = (base, auth) => fetch(`${base}/auth/verify`, { headers: auth ? { Authorization: auth } : {} });

test('verify: valid token -> 204 + X-User-Id', () =>
  withApp({}, async (base) => {
    const token = jwt.sign({ sub: '42' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await verify(base, `Bearer ${token}`);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('x-user-id'), '42');
  }));

test('verify: missing / malformed header -> 401', () =>
  withApp({}, async (base) => {
    assert.equal((await verify(base)).status, 401);
    assert.equal((await verify(base, 'Bearer')).status, 401);
    assert.equal((await verify(base, 'Basic abc')).status, 401);
    assert.equal((await verify(base, 'Bearer not.a.jwt')).status, 401);
  }));

test('verify: expired token -> 401', () =>
  withApp({}, async (base) => {
    const token = jwt.sign({ sub: '1' }, SECRET, { algorithm: 'HS256', expiresIn: -10 });
    assert.equal((await verify(base, `Bearer ${token}`)).status, 401);
  }));

test('verify: token signed with another secret -> 401', () =>
  withApp({}, async (base) => {
    const token = jwt.sign({ sub: '1' }, 'attacker-secret', { algorithm: 'HS256' });
    assert.equal((await verify(base, `Bearer ${token}`)).status, 401);
  }));

test('verify: alg=none token -> 401', () =>
  withApp({}, async (base) => {
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: '1' })}.`;
    assert.equal((await verify(base, `Bearer ${token}`)).status, 401);
  }));

test('verify: HS512 token (algorithm pinned to HS256) -> 401', () =>
  withApp({}, async (base) => {
    const token = jwt.sign({ sub: '1' }, SECRET, { algorithm: 'HS512' });
    assert.equal((await verify(base, `Bearer ${token}`)).status, 401);
  }));

test('verify: tampered payload -> 401', () =>
  withApp({}, async (base) => {
    const [h, , s] = jwt.sign({ sub: '1' }, SECRET).split('.');
    const forged = `${h}.${b64({ sub: '2' })}.${s}`;
    assert.equal((await verify(base, `Bearer ${forged}`)).status, 401);
  }));

// ---- /dashboard ----
const user = { id: '1', username: 'alice' };
const orders = [{ id: 'o1' }, { id: 'o2' }];

test('dashboard: both upstreams up -> 200 merged, X-User-Id forwarded', async () => {
  const u = stub(json(user));
  const o = stub(json(orders));
  const [uUrl, oUrl] = [await listen(u.server), await listen(o.server)];
  try {
    await withApp({ userServiceUrl: uUrl, orderServiceUrl: oUrl }, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { 'X-User-Id': '1' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { user, orders, partial: false });
    });
    assert.equal(u.seen[0]['x-user-id'], '1');
    assert.equal(o.seen[0]['x-user-id'], '1');
  } finally {
    await Promise.all([close(u.server), close(o.server)]);
  }
});

test('dashboard: order-service down -> 206 with partial data', async () => {
  const u = stub(json(user));
  const o = stub(json(orders));
  const [uUrl, oUrl] = [await listen(u.server), await listen(o.server)];
  await close(o.server); // cong dong -> ECONNREFUSED
  try {
    await withApp({ userServiceUrl: uUrl, orderServiceUrl: oUrl }, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { 'X-User-Id': '1' } });
      assert.equal(res.status, 206);
      assert.deepEqual(await res.json(), { user, orders: null, partial: true });
    });
  } finally {
    await close(u.server);
  }
});

test('dashboard: upstream returning 500 counts as down (206)', async () => {
  const u = stub(json(user));
  const o = stub((_req, res) => ((res.statusCode = 500), res.end()));
  const [uUrl, oUrl] = [await listen(u.server), await listen(o.server)];
  try {
    await withApp({ userServiceUrl: uUrl, orderServiceUrl: oUrl }, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { 'X-User-Id': '1' } });
      assert.equal(res.status, 206);
      assert.equal((await res.json()).orders, null);
    });
  } finally {
    await Promise.all([close(u.server), close(o.server)]);
  }
});

test('dashboard: hanging upstream is cut off by timeout (206, not a hang)', async () => {
  const u = stub(json(user));
  const o = stub(() => {}); // khong bao gio tra loi
  const [uUrl, oUrl] = [await listen(u.server), await listen(o.server)];
  try {
    await withApp({ userServiceUrl: uUrl, orderServiceUrl: oUrl, timeoutMs: 200 }, async (base) => {
      const t = Date.now();
      const res = await fetch(`${base}/dashboard`, { headers: { 'X-User-Id': '1' } });
      assert.equal(res.status, 206);
      assert.ok(Date.now() - t < 1500, 'must not wait for the hung upstream');
    });
  } finally {
    o.server.closeAllConnections();
    await Promise.all([close(u.server), close(o.server)]);
  }
});

test('dashboard: both down -> 502', () =>
  withApp({ userServiceUrl: 'http://127.0.0.1:1', orderServiceUrl: 'http://127.0.0.1:1' }, async (base) => {
    const res = await fetch(`${base}/dashboard`, { headers: { 'X-User-Id': '1' } });
    assert.equal(res.status, 502);
  }));

test('dashboard: without X-User-Id -> 401', () =>
  withApp({}, async (base) => {
    assert.equal((await fetch(`${base}/dashboard`)).status, 401);
  }));

test('dashboard: user id is URL-encoded when calling user-service', async () => {
  const u = stub(json(user));
  const url = await listen(u.server);
  const paths = [];
  u.server.on('request', (req) => paths.push(req.url));
  try {
    await withApp({ userServiceUrl: url, orderServiceUrl: 'http://127.0.0.1:1' }, async (base) => {
      await fetch(`${base}/dashboard`, { headers: { 'X-User-Id': '1/../admin' } });
    });
    assert.equal(paths[0], '/users/1%2F..%2Fadmin');
  } finally {
    await close(u.server);
  }
});

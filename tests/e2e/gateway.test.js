// E2E: chay tren stack that (`docker compose up`). Moi nhom test ung voi 1 yeu cau cua de.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GW, GW_LIMITED, signJwt, login, authed } = require('./helpers');

const now = () => Math.floor(Date.now() / 1000);

test.describe('1. Routing', () => {
  test.it('/users/:id and /orders reach the right service', async () => {
    const token = await login('alice');
    const user = await fetch(`${GW}/users/1`, authed(token));
    assert.equal(user.status, 200);
    assert.equal((await user.json()).username, 'alice'); // du lieu cua user-service

    const orders = await fetch(`${GW}/orders`, authed(token));
    assert.equal(orders.status, 200);
    assert.deepEqual((await orders.json()).map((o) => o.id), ['o1', 'o2']); // du lieu cua order-service
  });

  test.it('unknown path is not proxied anywhere -> 404', async () => {
    const token = await login('alice');
    assert.equal((await fetch(`${GW}/nope`, authed(token))).status, 404);
  });

  test.it('internal endpoints are not reachable through the gateway', async () => {
    const token = await login('alice');
    for (const path of ['/auth/verify', '/_auth', '/healthz']) {
      assert.equal((await fetch(GW + path, authed(token))).status, 404, path);
    }
  });
});

test.describe('2a. JWT offloading', () => {
  test.it('no token / garbage token -> 401 on every protected route', async () => {
    for (const path of ['/users/1', '/orders', '/dashboard', '/users/me/avatar-url']) {
      assert.equal((await fetch(GW + path)).status, 401, `${path} without token`);
      assert.equal((await fetch(GW + path, authed('abc.def.ghi'))).status, 401, `${path} garbage`);
    }
  });

  test.it('expired token -> 401', async () => {
    const t = signJwt({ sub: '1', iat: now() - 7200, exp: now() - 3600 });
    assert.equal((await fetch(`${GW}/orders`, authed(t))).status, 401);
  });

  test.it('token signed with the wrong secret -> 401', async () => {
    const t = signJwt({ sub: '1', exp: now() + 3600 }, { secret: 'attacker' });
    assert.equal((await fetch(`${GW}/orders`, authed(t))).status, 401);
  });

  test.it('alg=none token -> 401', async () => {
    const t = signJwt({ sub: '1', exp: now() + 3600 }, { alg: 'none' });
    assert.equal((await fetch(`${GW}/orders`, authed(t))).status, 401);
  });

  test.it('a valid token for a user that does not exist is rejected', async () => {
    const t = signJwt({ sub: '999', exp: now() + 3600 });
    assert.equal((await fetch(`${GW}/users/999`, authed(t))).status, 401);
  });

  test.it('client cannot spoof X-User-Id: gateway overwrites it', async () => {
    const token = await login('alice');
    // alice gia danh bob
    const res = await fetch(`${GW}/users/2`, authed(token, { 'X-User-Id': '2' }));
    assert.equal(res.status, 403);
    const orders = await (await fetch(`${GW}/orders`, authed(token, { 'X-User-Id': '2' }))).json();
    assert.deepEqual(orders.map((o) => o.id), ['o1', 'o2']); // van la don cua alice, khong phai o3 cua bob
  });

  test.it('X-User-Id alone (no token) does not authenticate', async () => {
    assert.equal((await fetch(`${GW}/orders`, { headers: { 'X-User-Id': '1' } })).status, 401);
  });

  test.it('login is public; bad credentials -> 401', async () => {
    const bad = await fetch(`${GW}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong' }),
    });
    assert.equal(bad.status, 401);
  });

  test.it('users cannot read each other\'s data', async () => {
    const bob = await login('bob');
    assert.equal((await fetch(`${GW}/users/1`, authed(bob))).status, 403);
    assert.equal((await fetch(`${GW}/orders/o1`, authed(bob))).status, 403);
    assert.equal((await fetch(`${GW}/orders/o3`, authed(bob))).status, 200);
  });
});

test.describe('2b. Rate limit 10 req/s at the gateway', () => {
  let token; // lay truoc cac burst: /auth/login cung bi rate limit
  test.before(async () => {
    token = await login('alice', undefined, GW_LIMITED);
    await new Promise((r) => setTimeout(r, 1200)); // de bucket hoi day
  });

  test.it('burst of 40 concurrent requests: some 200, some 429, never 5xx', async () => {
    const codes = await Promise.all(
      Array.from({ length: 40 }, () => fetch(`${GW_LIMITED}/orders`, authed(token)).then((r) => r.status)),
    );
    const ok = codes.filter((c) => c === 200).length;
    const limited = codes.filter((c) => c === 429).length;
    assert.equal(ok + limited, 40, `unexpected codes: ${[...new Set(codes)]}`);
    assert.ok(limited > 0, 'expected some 429');
    assert.ok(ok >= 1, 'expected some requests to pass');
    assert.ok(ok <= 20, `too many requests passed in one burst: ${ok}`); // 10 r/s + burst 5, co sai so thoi gian
  });

  test.it('after the burst the limit recovers', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await fetch(`${GW_LIMITED}/orders`, authed(token))).status, 200);
  });

  test.it('the benchmark port really is unlimited (so latency numbers are not skewed)', async () => {
    const token = await login('alice');
    const codes = await Promise.all(
      Array.from({ length: 40 }, () => fetch(`${GW}/orders`, authed(token)).then((r) => r.status)),
    );
    assert.ok(codes.every((c) => c === 200), `got ${[...new Set(codes)]}`);
  });
});

test.describe('3. Aggregation: /dashboard', () => {
  test.it('merges the user and only that user\'s orders', async () => {
    const res = await fetch(`${GW}/dashboard`, authed(await login('alice')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.partial, false);
    assert.equal(body.user.username, 'alice');
    assert.ok(!('password' in body.user));
    assert.deepEqual(body.orders.map((o) => o.id), ['o1', 'o2']);

    const bob = await (await fetch(`${GW}/dashboard`, authed(await login('bob')))).json();
    assert.equal(bob.user.username, 'bob');
    assert.deepEqual(bob.orders.map((o) => o.id), ['o3']);
  });
});

test.describe('4. Valet Key: pre-signed URL', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('ktpm-e2e')]);
  const requestUrl = async (token, contentType = 'image/png') => {
    const res = await fetch(`${GW}/users/me/avatar-url`, {
      method: 'POST',
      ...authed(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ contentType }),
    });
    return res;
  };

  test.it('rejects non-image content types', async () => {
    assert.equal((await requestUrl(await login('alice'), 'text/html')).status, 400);
  });

  test.it('URL expires in 300s, upload goes straight to storage, bytes round-trip', async () => {
    const token = await login('alice');
    const { uploadUrl, objectKey, expiresIn } = await (await requestUrl(token)).json();
    assert.equal(expiresIn, 300);
    assert.equal(new URL(uploadUrl).searchParams.get('X-Amz-Expires'), '300');
    assert.ok(objectKey.startsWith('1/'));
    assert.notEqual(new URL(uploadUrl).port, new URL(GW).port); // khong di qua gateway

    // chua upload -> chua xac nhan duoc
    const early = await fetch(`${GW}/users/me/avatar`, {
      method: 'POST',
      ...authed(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ objectKey }),
    });
    assert.equal(early.status, 404);

    const put = await fetch(uploadUrl, { method: 'PUT', body: png });
    assert.equal(put.status, 200);

    const confirm = await fetch(`${GW}/users/me/avatar`, {
      method: 'POST',
      ...authed(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ objectKey }),
    });
    assert.equal(confirm.status, 200);
    assert.equal((await confirm.json()).avatarKey, objectKey);

    const { url } = await (await fetch(`${GW}/users/me/avatar-url`, authed(token))).json();
    const got = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.ok(got.equals(png), 'downloaded bytes differ from uploaded bytes');
  });

  test.it('tampered signature is refused by storage (403)', async () => {
    const { uploadUrl } = await (await requestUrl(await login('alice'))).json();
    const u = new URL(uploadUrl);
    u.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    assert.equal((await fetch(u, { method: 'PUT', body: png })).status, 403);
  });

  test.it('URL is bound to one object key: cannot reuse it for another key', async () => {
    const { uploadUrl } = await (await requestUrl(await login('alice'))).json();
    const u = new URL(uploadUrl);
    u.pathname = u.pathname.replace('/avatars/1/', '/avatars/2/'); // thu ghi vao thu muc cua bob
    assert.equal((await fetch(u, { method: 'PUT', body: png })).status, 403);
  });

  test.it('the signed URL only works for PUT (not GET/DELETE)', async () => {
    const { uploadUrl } = await (await requestUrl(await login('alice'))).json();
    assert.equal((await fetch(uploadUrl, { method: 'DELETE' })).status, 403);
    assert.equal((await fetch(uploadUrl, { method: 'GET' })).status, 403);
  });

  test.it('bob cannot claim alice\'s uploaded object as his avatar', async () => {
    const alice = await login('alice');
    const { uploadUrl, objectKey } = await (await requestUrl(alice)).json();
    await fetch(uploadUrl, { method: 'PUT', body: png });
    const res = await fetch(`${GW}/users/me/avatar`, {
      method: 'POST',
      ...authed(await login('bob'), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ objectKey }),
    });
    assert.equal(res.status, 400);
  });
});

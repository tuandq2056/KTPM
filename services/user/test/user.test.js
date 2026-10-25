const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const Minio = require('minio');
const { createApp, URL_TTL_SECONDS } = require('../server');

const SECRET = 'test-secret';

// Ky that (khong goi mang vi da co region) voi host "public" gia.
const signingClient = new Minio.Client({
  endPoint: 'files.example.test',
  port: 9000,
  useSSL: false,
  accessKey: 'AK',
  secretKey: 'SK',
  region: 'us-east-1',
});

// internalClient gia: statObject thanh cong chi voi key nam trong `uploaded`.
function fakeInternal(uploaded = new Set()) {
  return {
    uploaded,
    statObject: async (_bucket, key) => {
      if (!uploaded.has(key)) throw new Error('NotFound');
      return { size: 1 };
    },
  };
}

async function withApp(internal, fn) {
  const server = createApp({ internalClient: internal, signingClient, jwtSecret: SECRET, bucket: 'avatars' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { uid, body } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(uid ? { 'X-User-Id': uid } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---- login ----
test('login: valid credentials -> HS256 JWT for that user, expires in ~1h', () =>
  withApp(fakeInternal(), async (call) => {
    const res = await call('POST', '/auth/login', { body: { username: 'alice', password: 'alice123' } });
    assert.equal(res.status, 200);
    const { token } = await res.json();
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    assert.equal(payload.sub, '1');
    assert.ok(Math.abs(payload.exp - payload.iat - 3600) <= 1);
  }));

test('login: wrong password / unknown user / empty body -> 401', () =>
  withApp(fakeInternal(), async (call) => {
    for (const body of [{ username: 'alice', password: 'x' }, { username: 'nobody', password: 'x' }, {}]) {
      assert.equal((await call('POST', '/auth/login', { body })).status, 401);
    }
    assert.equal((await call('POST', '/auth/login')).status, 401); // khong co body
  }));

// ---- GET /users/:id ----
test('GET /users/:id: only yourself; password is never exposed', () =>
  withApp(fakeInternal(), async (call) => {
    assert.equal((await call('GET', '/users/1')).status, 401);
    assert.equal((await call('GET', '/users/2', { uid: '1' })).status, 403);
    assert.equal((await call('GET', '/users/1', { uid: '999' })).status, 401); // user khong ton tai
    const res = await call('GET', '/users/1', { uid: '1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, 'alice');
    assert.ok(!('password' in body));
  }));

// ---- Valet Key: cap URL ----
test('avatar-url: rejects missing / non-image content types', () =>
  withApp(fakeInternal(), async (call) => {
    for (const body of [undefined, {}, { contentType: 'text/html' }, { contentType: 'application/x-sh' }]) {
      assert.equal((await call('POST', '/users/me/avatar-url', { uid: '1', body })).status, 400);
    }
  }));

test('avatar-url: requires login', () =>
  withApp(fakeInternal(), async (call) => {
    const res = await call('POST', '/users/me/avatar-url', { body: { contentType: 'image/png' } });
    assert.equal(res.status, 401);
  }));

test('avatar-url: signed PUT url, 300s expiry, key scoped to the user', () =>
  withApp(fakeInternal(), async (call) => {
    const res = await call('POST', '/users/me/avatar-url', { uid: '1', body: { contentType: 'image/png' } });
    assert.equal(res.status, 200);
    const out = await res.json();
    const url = new URL(out.uploadUrl);
    assert.equal(url.host, 'files.example.test:9000'); // host public, khong phai minio:9000
    assert.ok(url.pathname.startsWith('/avatars/1/'), url.pathname);
    assert.equal(url.pathname, `/avatars/${out.objectKey}`);
    assert.ok(out.objectKey.endsWith('.png'));
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.equal(URL_TTL_SECONDS, 300);
    assert.equal(out.expiresIn, 300);
    assert.ok(url.searchParams.get('X-Amz-Signature'));
  }));

test('avatar-url: every call yields a fresh key; user 2 gets keys under /2/', () =>
  withApp(fakeInternal(), async (call) => {
    const body = { contentType: 'image/jpeg' };
    const a = await (await call('POST', '/users/me/avatar-url', { uid: '1', body })).json();
    const b = await (await call('POST', '/users/me/avatar-url', { uid: '1', body })).json();
    const c = await (await call('POST', '/users/me/avatar-url', { uid: '2', body })).json();
    assert.notEqual(a.objectKey, b.objectKey);
    assert.ok(c.objectKey.startsWith('2/') && c.objectKey.endsWith('.jpg'));
  }));

// ---- Valet Key: xac nhan ----
test('confirm: refuses other users\' keys, traversal and junk', () =>
  withApp(fakeInternal(), async (call) => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const bad = [
      `2/${uuid}.png`, // key cua user khac
      `1/../2/${uuid}.png`, // path traversal
      `1/${uuid}.exe`, // sai duoi
      '1/avatar.png', // khong phai key do service cap
      '', 123, null,
    ];
    for (const objectKey of bad) {
      const res = await call('POST', '/users/me/avatar', { uid: '1', body: { objectKey } });
      assert.equal(res.status, 400, `should reject ${JSON.stringify(objectKey)}`);
    }
  }));

test('confirm: 404 until the object really exists in storage', () =>
  withApp(fakeInternal(), async (call) => {
    const { objectKey } = await (
      await call('POST', '/users/me/avatar-url', { uid: '1', body: { contentType: 'image/png' } })
    ).json();
    const res = await call('POST', '/users/me/avatar', { uid: '1', body: { objectKey } });
    assert.equal(res.status, 404);
    assert.equal((await (await call('GET', '/users/1', { uid: '1' })).json()).avatarKey, null);
  }));

test('confirm: after upload -> avatar saved, signed GET url available', () => {
  const internal = fakeInternal();
  return withApp(internal, async (call) => {
    assert.equal((await call('GET', '/users/me/avatar-url', { uid: '1' })).status, 404); // chua co avatar
    const { objectKey } = await (
      await call('POST', '/users/me/avatar-url', { uid: '1', body: { contentType: 'image/webp' } })
    ).json();
    internal.uploaded.add(objectKey); // gia lap client da PUT xong
    const res = await call('POST', '/users/me/avatar', { uid: '1', body: { objectKey } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).avatarKey, objectKey);

    const got = await (await call('GET', '/users/me/avatar-url', { uid: '1' })).json();
    const url = new URL(got.url);
    assert.equal(url.pathname, `/avatars/${objectKey}`);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    // user khac khong thay avatar cua alice
    assert.equal((await call('GET', '/users/me/avatar-url', { uid: '2' })).status, 404);
  });
});

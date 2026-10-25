// Chaos: tat order-service that, kiem tra /dashboard ha cap thay vi sap.
// Chi chay khi E2E_CHAOS=1 (vi lam dung stack). Ten "zz-" + --test-concurrency=1 de chay sau cung.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { GW, login, authed } = require('./helpers');

const compose = (...args) => execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });

test('dashboard degrades to 206 when order-service is down, recovers afterwards', { skip: !process.env.E2E_CHAOS }, async () => {
  const token = await login('alice');
  try {
    compose('stop', 'order-service');
    const t = Date.now();
    const res = await fetch(`${GW}/dashboard`, authed(token));
    assert.equal(res.status, 206);
    const body = await res.json();
    assert.equal(body.partial, true);
    assert.equal(body.user.username, 'alice');
    assert.equal(body.orders, null);
    assert.ok(Date.now() - t < 5000, 'must answer quickly even though a dependency is down');

    // /orders truc tiep: gateway phai bao loi nhanh (5xx), khong treo 60s
    const t2 = Date.now();
    const direct = await fetch(`${GW}/orders`, authed(token));
    assert.ok(direct.status >= 500, `got ${direct.status}`);
    assert.ok(Date.now() - t2 < 5000, `gateway took ${Date.now() - t2}ms to fail`);
  } finally {
    compose('start', 'order-service');
  }
  // Hoi phuc: container restart thuong doi IP; gateway phai phan giai lai ten (khong giu IP cu).
  for (const path of ['/dashboard', '/orders']) {
    let status;
    for (let i = 0; i < 30; i++) {
      status = (await fetch(GW + path, { ...authed(token), signal: AbortSignal.timeout(3000) }).catch(() => ({ status: 0 }))).status;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(status, 200, `${path} should return to 200 after order-service restarts`);
  }
});

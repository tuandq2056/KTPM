// Do do tre: goi thang service vs di qua gateway (cong 8081, khong rate limit).
// Chay: node scripts/bench.js [soRequest] [concurrency]
const N = Number(process.argv[2] || 2000);
const C = Number(process.argv[3] || 10);
const GW = process.env.GW || 'http://localhost:8089';
const DIRECT = process.env.DIRECT || 'http://localhost:3002';

async function login() {
  const r = await fetch(`${GW}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'alice123' }),
  });
  return (await r.json()).token;
}

async function run(name, url, headers) {
  const lat = [];
  let errors = 0;
  let next = 0;
  const worker = async () => {
    while (next++ < N) {
      const t = performance.now();
      try {
        const r = await fetch(url, { headers });
        await r.arrayBuffer();
        if (!r.ok) errors++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - t);
    }
  };
  for (let i = 0; i < 100; i++) await fetch(url, { headers }).then((r) => r.arrayBuffer()); // warm-up
  const start = performance.now();
  await Promise.all(Array.from({ length: C }, worker));
  const secs = (performance.now() - start) / 1000;
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(2);
  return { name, req: lat.length, errors, 'rps': (lat.length / secs).toFixed(0), 'p50 ms': p(0.5), 'p95 ms': p(0.95), 'p99 ms': p(0.99) };
}

(async () => {
  const token = await login();
  console.log(`N=${N} concurrency=${C}`);
  const rows = [];
  // Xen ke 2 vong de giam sai lech do nhiet/cache.
  for (let round = 0; round < 2; round++) {
    rows.push(await run(`direct  (order-service) #${round + 1}`, `${DIRECT}/orders`, { 'X-User-Id': '1' }));
    rows.push(await run(`gateway (JWT+nginx)     #${round + 1}`, `${GW}/orders`, { Authorization: `Bearer ${token}` }));
  }
  console.table(rows);
})();

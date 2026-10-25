const express = require('express');
const jwt = require('jsonwebtoken');

const {
  JWT_SECRET = 'dev-secret-change-me',
  USER_SERVICE_URL = 'http://user-service:3000',
  ORDER_SERVICE_URL = 'http://order-service:3000',
} = process.env;

const app = express();

// nginx auth_request goi vao day. 2xx = cho qua, 401 = chan.
app.get('/auth/verify', (req, res) => {
  const [scheme, token] = (req.header('Authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).end();
  try {
    // Ghim thuat toan de chan alg:none / doi alg.
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    res.set('X-User-Id', String(payload.sub)).status(204).end();
  } catch {
    res.status(401).end();
  }
});

// Aggregation: gop thong tin user + don hang cua user do trong 1 response.
app.get('/dashboard', async (req, res) => {
  const uid = req.header('X-User-Id');
  if (!uid) return res.status(401).json({ error: 'missing X-User-Id' });
  const headers = { 'X-User-Id': uid };
  const timeout = () => AbortSignal.timeout(2000);

  // Goi song song; mot ben loi thi tra du lieu mot phan thay vi sap ca trang.
  const [userRes, orderRes] = await Promise.allSettled([
    fetch(`${USER_SERVICE_URL}/users/${encodeURIComponent(uid)}`, { headers, signal: timeout() }),
    fetch(`${ORDER_SERVICE_URL}/orders`, { headers, signal: timeout() }),
  ]);

  const unwrap = async (r) => (r.status === 'fulfilled' && r.value.ok ? r.value.json() : null);
  const user = await unwrap(userRes);
  const orders = await unwrap(orderRes);

  if (!user && !orders) return res.status(502).json({ error: 'upstream unavailable' });
  const partial = !user || !orders;
  res.status(partial ? 206 : 200).json({ user, orders, partial });
});

app.listen(3000, () => console.log('bff on :3000'));

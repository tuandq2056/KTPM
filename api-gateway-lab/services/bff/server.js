const express = require('express');
const jwt = require('jsonwebtoken');

const DEFAULTS = {
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  userServiceUrl: process.env.USER_SERVICE_URL || 'http://user-service:3000',
  orderServiceUrl: process.env.ORDER_SERVICE_URL || 'http://order-service:3000',
  timeoutMs: 2000,
};

function createApp(opts = {}) {
  const { jwtSecret, userServiceUrl, orderServiceUrl, timeoutMs } = { ...DEFAULTS, ...opts };
  const app = express();

  // nginx auth_request goi vao day. 2xx = cho qua, 401 = chan.
  app.get('/auth/verify', (req, res) => {
    const [scheme, token] = (req.header('Authorization') || '').split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).end();
    try {
      // Ghim thuat toan de chan alg:none / doi alg.
      const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
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

    // Doc ca body TRONG promise: neu doc sau allSettled thi signal cua ben nhanh da het han
    // (do ben cham keo dai) va .json() nem AbortError -> request treo vi Express 4 khong bat.
    const getJson = async (url) => {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      return r.json();
    };

    // Goi song song; mot ben loi thi tra du lieu mot phan thay vi sap ca trang.
    const [userRes, orderRes] = await Promise.allSettled([
      getJson(`${userServiceUrl}/users/${encodeURIComponent(uid)}`),
      getJson(`${orderServiceUrl}/orders`),
    ]);
    const user = userRes.status === 'fulfilled' ? userRes.value : null;
    const orders = orderRes.status === 'fulfilled' ? orderRes.value : null;

    if (!user && !orders) return res.status(502).json({ error: 'upstream unavailable' });
    const partial = !user || !orders;
    res.status(partial ? 206 : 200).json({ user, orders, partial });
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  createApp().listen(3000, () => console.log('bff on :3000'));
}

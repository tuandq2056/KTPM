const express = require('express');

// Data in-memory (bai lab)
const seedOrders = () => [
  { id: 'o1', userId: '1', item: 'Keyboard', total: 50 },
  { id: 'o2', userId: '1', item: 'Mouse', total: 20 },
  { id: 'o3', userId: '2', item: 'Monitor', total: 200 },
];

function createApp(orders = seedOrders()) {
  const app = express();

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  function requireUser(req, res, next) {
    const uid = req.header('X-User-Id');
    if (!uid) return res.status(401).json({ error: 'missing X-User-Id' });
    req.userId = uid;
    next();
  }

  // Chi tra don hang cua chinh user dang dang nhap.
  app.get('/orders', requireUser, (req, res) => {
    res.json(orders.filter((o) => o.userId === req.userId));
  });

  app.get('/orders/:id', requireUser, (req, res) => {
    const order = orders.find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });
    if (order.userId !== req.userId) return res.status(403).json({ error: 'forbidden' });
    res.json(order);
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  createApp().listen(3000, () => console.log('order-service on :3000'));
}

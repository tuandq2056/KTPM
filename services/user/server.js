const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const Minio = require('minio');

const {
  JWT_SECRET = 'dev-secret-change-me',
  MINIO_ENDPOINT = 'minio',
  MINIO_PORT = '9000',
  MINIO_PUBLIC_HOST = 'localhost',
  MINIO_PUBLIC_PORT = '9000',
  MINIO_ACCESS_KEY = 'minioadmin',
  MINIO_SECRET_KEY = 'minioadmin',
  MINIO_BUCKET = 'avatars',
} = process.env;

const URL_TTL_SECONDS = 300; // pre-signed URL het han sau 5 phut
const REGION = 'us-east-1';
const ALLOWED_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const OBJECT_KEY_RE = (uid) =>
  new RegExp(`^${uid}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(png|jpg|webp)$`);

// Data in-memory (bai lab). Password plaintext chi de demo.
const seedUsers = () =>
  new Map([
    ['1', { id: '1', username: 'alice', password: 'alice123', name: 'Alice', avatarKey: null }],
    ['2', { id: '2', username: 'bob', password: 'bob123', name: 'Bob', avatarKey: null }],
  ]);

const publicView = ({ id, username, name, avatarKey }) => ({ id, username, name, avatarKey });

// internalClient: kiem tra bucket / stat object qua mang docker.
// signingClient: chi dung de KY URL. Host trong chu ky phai la host client dung de upload
//   (localhost:9000), neu khong MinIO tra SignatureDoesNotMatch. Co set region san nen
//   viec ky khong can goi mang.
function createApp({ internalClient, signingClient, jwtSecret = JWT_SECRET, bucket = MINIO_BUCKET }) {
  const users = seedUsers();
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Public (gateway cho qua khong can JWT)
  app.post('/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = [...users.values()].find((u) => u.username === username && u.password === password);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const token = jwt.sign({ sub: user.id, username: user.username }, jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    res.json({ token });
  });

  // Cac route duoi day tin header X-User-Id do gateway dat (service khong public truc tiep).
  function requireUser(req, res, next) {
    const uid = req.header('X-User-Id');
    if (!uid || !users.has(uid)) return res.status(401).json({ error: 'missing or unknown X-User-Id' });
    req.userId = uid;
    next();
  }

  // Phai khai bao /users/me/... TRUOC /users/:id
  // Valet Key: cap URL co han, client PUT thang len MinIO (khong di qua service).
  app.post('/users/me/avatar-url', requireUser, async (req, res) => {
    const ext = ALLOWED_TYPES[req.body && req.body.contentType];
    if (!ext) {
      return res.status(400).json({ error: `contentType must be one of ${Object.keys(ALLOWED_TYPES).join(', ')}` });
    }
    // Key gan voi user dang dang nhap -> khong ghi de duoc anh cua nguoi khac.
    const objectKey = `${req.userId}/${crypto.randomUUID()}.${ext}`;
    try {
      const uploadUrl = await signingClient.presignedPutObject(bucket, objectKey, URL_TTL_SECONDS);
      res.json({ uploadUrl, objectKey, method: 'PUT', expiresIn: URL_TTL_SECONDS });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'cannot sign url' });
    }
  });

  // Sau khi upload xong, client bao lai; service kiem tra object that su ton tai.
  app.post('/users/me/avatar', requireUser, async (req, res) => {
    const { objectKey } = req.body || {};
    // Khop chat dinh dang key do service cap (chan ca ../ va key cua user khac).
    if (typeof objectKey !== 'string' || !OBJECT_KEY_RE(req.userId).test(objectKey)) {
      return res.status(400).json({ error: 'objectKey must be an avatar key issued to current user' });
    }
    try {
      await internalClient.statObject(bucket, objectKey);
    } catch {
      return res.status(404).json({ error: 'object not uploaded yet' });
    }
    users.get(req.userId).avatarKey = objectKey;
    res.json(publicView(users.get(req.userId)));
  });

  app.get('/users/me/avatar-url', requireUser, async (req, res) => {
    const user = users.get(req.userId);
    if (!user.avatarKey) return res.status(404).json({ error: 'no avatar' });
    const url = await signingClient.presignedGetObject(bucket, user.avatarKey, URL_TTL_SECONDS);
    res.json({ url, expiresIn: URL_TTL_SECONDS });
  });

  app.get('/users/:id', requireUser, (req, res) => {
    if (req.params.id !== req.userId) return res.status(403).json({ error: 'forbidden' });
    res.json(publicView(users.get(req.params.id)));
  });

  return app;
}

async function ensureBucket(client, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      if (!(await client.bucketExists(MINIO_BUCKET))) await client.makeBucket(MINIO_BUCKET, REGION);
      console.log(`bucket "${MINIO_BUCKET}" ready`);
      return;
    } catch (err) {
      console.log(`waiting for minio (${i + 1}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('minio not reachable');
}

module.exports = { createApp, URL_TTL_SECONDS };

if (require.main === module) {
  const common = { useSSL: false, accessKey: MINIO_ACCESS_KEY, secretKey: MINIO_SECRET_KEY, region: REGION };
  const internalClient = new Minio.Client({ ...common, endPoint: MINIO_ENDPOINT, port: Number(MINIO_PORT) });
  const signingClient = new Minio.Client({ ...common, endPoint: MINIO_PUBLIC_HOST, port: Number(MINIO_PUBLIC_PORT) });
  ensureBucket(internalClient)
    .then(() => createApp({ internalClient, signingClient }).listen(3000, () => console.log('user-service on :3000')))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

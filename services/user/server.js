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

// In-memory data (bai lab). Password plaintext chi de demo.
const users = new Map([
  ['1', { id: '1', username: 'alice', password: 'alice123', name: 'Alice', avatarKey: null }],
  ['2', { id: '2', username: 'bob', password: 'bob123', name: 'Bob', avatarKey: null }],
]);

// Client "noi bo": dung de kiem tra bucket / stat object qua mang docker.
const internalClient = new Minio.Client({
  endPoint: MINIO_ENDPOINT,
  port: Number(MINIO_PORT),
  useSSL: false,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
  region: REGION,
});

// Client "public": chi dung de KY URL. Host trong chu ky phai la host client dung
// de upload (localhost:9000), neu khong MinIO tra SignatureDoesNotMatch.
// Co set region san nen viec ky khong can goi mang toi host public.
const signingClient = new Minio.Client({
  endPoint: MINIO_PUBLIC_HOST,
  port: Number(MINIO_PUBLIC_PORT),
  useSSL: false,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
  region: REGION,
});

async function ensureBucket(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      if (!(await internalClient.bucketExists(MINIO_BUCKET))) {
        await internalClient.makeBucket(MINIO_BUCKET, REGION);
      }
      console.log(`bucket "${MINIO_BUCKET}" ready`);
      return;
    } catch (err) {
      console.log(`waiting for minio (${i + 1}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('minio not reachable');
}

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Public (gateway cho qua khong can JWT)
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = [...users.values()].find((u) => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
  res.json({ token });
});

// Cac route duoi day tin header X-User-Id do gateway dat (service khong public truc tiep).
function requireUser(req, res, next) {
  const uid = req.header('X-User-Id');
  if (!uid) return res.status(401).json({ error: 'missing X-User-Id' });
  req.userId = uid;
  next();
}

const publicView = ({ id, username, name, avatarKey }) => ({ id, username, name, avatarKey });

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
    const uploadUrl = await signingClient.presignedPutObject(MINIO_BUCKET, objectKey, URL_TTL_SECONDS);
    res.json({ uploadUrl, objectKey, method: 'PUT', expiresIn: URL_TTL_SECONDS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'cannot sign url' });
  }
});

// Sau khi upload xong, client bao lai; service kiem tra object that su ton tai.
app.post('/users/me/avatar', requireUser, async (req, res) => {
  const { objectKey } = req.body || {};
  if (typeof objectKey !== 'string' || !objectKey.startsWith(`${req.userId}/`)) {
    return res.status(400).json({ error: 'objectKey must belong to current user' });
  }
  try {
    await internalClient.statObject(MINIO_BUCKET, objectKey);
  } catch {
    return res.status(404).json({ error: 'object not uploaded yet' });
  }
  users.get(req.userId).avatarKey = objectKey;
  res.json(publicView(users.get(req.userId)));
});

app.get('/users/me/avatar-url', requireUser, async (req, res) => {
  const user = users.get(req.userId);
  if (!user || !user.avatarKey) return res.status(404).json({ error: 'no avatar' });
  const url = await signingClient.presignedGetObject(MINIO_BUCKET, user.avatarKey, URL_TTL_SECONDS);
  res.json({ url, expiresIn: URL_TTL_SECONDS });
});

app.get('/users/:id', requireUser, (req, res) => {
  if (req.params.id !== req.userId) return res.status(403).json({ error: 'forbidden' });
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(publicView(user));
});

ensureBucket()
  .then(() => app.listen(3000, () => console.log('user-service on :3000')))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// Dung chung cho cac e2e test. Chi dung API co san cua Node (khong can npm install).
const crypto = require('node:crypto');

const GW = process.env.GW || 'http://localhost:8089'; // khong rate limit: test chuc nang
const GW_LIMITED = process.env.GW_LIMITED || 'http://localhost:8088'; // co rate limit 10 r/s
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// Tu ky JWT HS256 (de tao token het han / sai) ma khong can thu vien.
function signJwt(payload, { secret = JWT_SECRET, alg = 'HS256' } = {}) {
  const head = `${b64({ alg, typ: 'JWT' })}.${b64(payload)}`;
  if (alg === 'none') return `${head}.`;
  return `${head}.${crypto.createHmac('sha256', secret).update(head).digest('base64url')}`;
}

async function login(username = 'alice', password = `${username}123`, base = GW) {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login ${username} -> ${res.status}`);
  return (await res.json()).token;
}

const authed = (token, extra = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...extra } });

module.exports = { GW, GW_LIMITED, signJwt, login, authed };

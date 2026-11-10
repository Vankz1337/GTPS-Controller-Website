'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { GtpsController } = require('./lib/gtps');
const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('config.json is missing. Copy config.example.json to config.json and follow the setup steps in README.md.');
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!config.admin?.username || !String(config.admin.passwordHash || '').startsWith('scrypt$')) {
    throw new Error('Set admin.username and admin.passwordHash in config.json. Generate the hash with: npm run hash-password -- "your-password"');
  }
  if (!config.sessionSecret || String(config.sessionSecret).length < 32 || String(config.sessionSecret).startsWith('change-this')) {
    throw new Error('Set sessionSecret in config.json to a random value with at least 32 characters.');
  }
  config.host = config.host || '127.0.0.1';
  config.port = Number(config.port) || 3000;
  return config;
}

const config = loadConfig();
const controller = new GtpsController(config, ROOT);

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function signSession(id) {
  return crypto.createHmac('sha256', config.sessionSecret).update(id).digest('hex');
}

function getSession(req) {
  const raw = cookieValue(req, 'gtps_session');
  if (!raw) return null;
  const [id, signature] = raw.split('.');
  if (!id || !signature) return null;
  const expected = signSession(id);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return { id, ...session };
}

function createSession(res) {
  const id = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  sessions.set(id, { username: config.admin.username, csrf, expiresAt: Date.now() + SESSION_TTL });
  const secure = config.secureCookies ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gtps_session=${id}.${signSession(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure}`);
  return csrf;
}

function clearSession(req, res) {
  const session = getSession(req);
  if (session) sessions.delete(session.id);
  const secure = config.secureCookies ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gtps_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function verifyPassword(password, encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = await scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

function checkLoginLimit(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (item.resetAt <= now) {
    item.count = 0;
    item.resetAt = now + 15 * 60 * 1000;
  }
  if (item.count >= 8) return false;
  item.count += 1;
  loginAttempts.set(ip, item);
  return true;
}

function clearLoginLimit(ip) { loginAttempts.delete(ip); }

async function readBody(req, maxBytes = 1024 * 1024) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > maxBytes) throw new Error('Request body is too large.');
  }
  if (!data) return {};
  try { return JSON.parse(data); }
  catch { throw new Error('Request body must be valid JSON.'); }
}

function requireCsrf(req, session) {
  const token = req.headers['x-csrf-token'];
  return typeof token === 'string' && timingSafeTextEqual(token, session.csrf);
}

function getContentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, 404, { error: 'Not found.' });
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return sendJson(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': getContentType(file), 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch { sendJson(res, 404, { error: 'Not found.' }); }
}

async function route(req, res) {
  setSecurityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  if (method === 'POST' && pathname === '/api/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!checkLoginLimit(ip)) return sendJson(res, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
    const body = await readBody(req);
    const usernameOk = timingSafeTextEqual(body.username || '', config.admin.username);
    const passwordOk = typeof body.password === 'string' && body.password.length <= 200 && await verifyPassword(body.password, config.admin.passwordHash);
    if (!usernameOk || !passwordOk) {
      await controller.audit('auth.login_failed', { ip });
      return sendJson(res, 401, { error: 'Username or password is incorrect.' });
    }
    clearLoginLimit(ip);
    const csrf = createSession(res);
    await controller.audit('auth.login', { username: config.admin.username });
    return sendJson(res, 200, { authenticated: true, username: config.admin.username, csrf });
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Please log in again.' });
    if (!requireCsrf(req, session)) return sendJson(res, 403, { error: 'Session token is missing or invalid.' });
    await controller.audit('auth.logout', { username: session.username });
    clearSession(req, res);
    return sendJson(res, 200, { authenticated: false });
  }

  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
  if (method !== 'GET' && !requireCsrf(req, session)) return sendJson(res, 403, { error: 'Session token is missing or invalid.' });

  if (method === 'GET' && pathname === '/api/session') {
    return sendJson(res, 200, { authenticated: true, username: session.username, csrf: session.csrf });
  }
  if (method === 'GET' && pathname === '/api/overview') return sendJson(res, 200, await controller.getOverview());
  if (method === 'GET' && pathname === '/api/activity') return sendJson(res, 200, { items: await controller.getActivity(40) });
  if (method === 'GET' && pathname === '/api/server-log') return sendJson(res, 200, { lines: await controller.getServerLog(100) });
  if (method === 'GET' && pathname === '/api/players') {
    return sendJson(res, 200, { items: await controller.searchPlayers(url.searchParams.get('q') || '') });
  }
  if (method === 'GET' && pathname.startsWith('/api/players/')) {
    const id = pathname.slice('/api/players/'.length);
    return sendJson(res, 200, await controller.readPlayer(id));
  }
  if (method === 'POST' && pathname.startsWith('/api/players/')) {
    const id = pathname.slice('/api/players/'.length);
    const body = await readBody(req);
    return sendJson(res, 200, await controller.adjustPlayer(id, body.field, body.amount, body.operation));
  }
  if (method === 'POST' && pathname === '/api/server/action') {
    const body = await readBody(req);
    return sendJson(res, 200, await controller.serverAction(body.action));
  }
  if (method === 'POST' && pathname === '/api/maintenance') {
    const body = await readBody(req);
    if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'Maintenance state must be true or false.' });
    return sendJson(res, 200, await controller.setMaintenance(body.enabled, body.message));
  }

  return sendJson(res, 404, { error: 'API route not found.' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = /not found/i.test(error.message) ? 404 : 400;
    sendJson(res, status, { error: error.message || 'Something went wrong.' });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`GTPS Controller is running at http://${config.host}:${config.port}`);
  console.log('Keep this panel on the same maching as your GTPS files.');
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

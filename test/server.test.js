'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForPanel(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Dashboard process exited before it was ready.');
    try {
      const response = await fetch(url + '/api/session');
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Dashboard did not start within the test window.');
}

test('HTTP admin flow protects routes, checks CSRF and handles player changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtps-http-'));
  let child = null;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(root, 'lib'), { recursive: true });
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.mkdir(path.join(root, 'players'), { recursive: true });
  await fs.mkdir(path.join(root, 'worlds'), { recursive: true });
  await fs.mkdir(path.join(root, 'gemdb'), { recursive: true });
  await fs.copyFile(path.join(__dirname, '..', 'server.js'), path.join(root, 'server.js'));
  await fs.copyFile(path.join(__dirname, '..', 'lib', 'gtps.js'), path.join(root, 'lib', 'gtps.js'));
  await fs.cp(path.join(__dirname, '..', 'public'), path.join(root, 'public'), { recursive: true });

  await fs.writeFile(path.join(root, 'players', 'TestGrow_.json'), JSON.stringify({
    gems: 10, wls: 4, xp: 120, level: 3, adminLevel: 0, password: 'keep-this-private'
  }));
  await fs.writeFile(path.join(root, 'gemdb', 'TestGrow.txt'), '900');
  await fs.writeFile(path.join(root, 'worlds', 'START.json'), '{}');
  await fs.writeFile(path.join(root, 'online.txt'), '17');
  await fs.writeFile(path.join(root, 'server_data.php'), 'server|127.0.0.1\n#maint|Closed\nRTENDMARKERBS1001');

  const password = 'test-admin-password-123';
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const port = await unusedPort();
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    host: '127.0.0.1',
    port: port,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    secureCookies: false,
    admin: {
      username: 'test-admin',
      passwordHash: 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex')
    },
    paths: {
      serverExecutable: './missing-test-server.exe',
      serverWorkingDirectory: '.',
      players: './players',
      worlds: './worlds',
      gemDb: './gemdb',
      serverData: './server_data.php',
      onlineFile: './online.txt',
      serverLog: './server.log',
      backups: './backups',
      auditLog: './data/admin-actions.log'
    },
    server: { processName: 'not-a-real-gtps-test-process' }
  }));

  const base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore' });
  await waitForPanel(base, child);

  const locked = await fetch(base + '/api/overview');
  assert.equal(locked.status, 401);

  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: password })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.authenticated, true);
  assert.ok(loginBody.csrf);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const overview = await fetch(base + '/api/overview', { headers: { cookie: cookie } });
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).online, 17);

  const blockedChange = await fetch(base + '/api/maintenance', {
    method: 'POST',
    headers: { cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, message: 'Back soon' })
  });
  assert.equal(blockedChange.status, 403);

  const maintenance = await fetch(base + '/api/maintenance', {
    method: 'POST',
    headers: { cookie: cookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrf },
    body: JSON.stringify({ enabled: true, message: 'Back soon' })
  });
  assert.equal(maintenance.status, 200);
  assert.match(await fs.readFile(path.join(root, 'server_data.php'), 'utf8'), /\nmaint\|Back soon\n/);

  const player = await fetch(base + '/api/players/TestGrow', { headers: { cookie: cookie } });
  assert.equal(player.status, 200);
  const playerBody = await player.json();
  assert.equal(playerBody.gems, 900);
  assert.equal(Object.hasOwn(playerBody, 'password'), false);

  const changed = await fetch(base + '/api/players/TestGrow', {
    method: 'POST',
    headers: { cookie: cookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrf },
    body: JSON.stringify({ field: 'gems', amount: 100, operation: 'add' })
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).value, 1000);
  assert.equal(await fs.readFile(path.join(root, 'gemdb', 'TestGrow.txt'), 'utf8'), '1000');
  assert.ok((await fs.readdir(path.join(root, 'backups'))).length >= 2);

  const logout = await fetch(base + '/api/logout', {
    method: 'POST',
    headers: { cookie: cookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrf },
    body: '{}'
  });
  assert.equal(logout.status, 200);
  const expired = await fetch(base + '/api/session', { headers: { cookie: cookie } });
  assert.equal(expired.status, 401);
});

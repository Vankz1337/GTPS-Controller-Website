'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  GtpsController,
  applyNumericChange,
  formatBytes,
  isInside,
  readMaintenance,
  validatePlayerId,
  writeMaintenance
} = require('../lib/gtps');

test('maintenance parser understands active and commented flags', () => {
  assert.deepEqual(readMaintenance('server|127.0.0.1\nmaint|Back soon\nRTENDMARKERBS1001'), { enabled: true, message: 'Back soon' });
  assert.deepEqual(readMaintenance('server|127.0.0.1\n#maint|Closed\nRTENDMARKERBS1001'), { enabled: false, message: 'Closed' });
});

test('maintenance writer changes only the flag and keeps the marker', () => {
  const source = 'server|127.0.0.1\n#maint|Old message\nRTENDMARKERBS1001';
  const active = writeMaintenance(source, true, 'New message');
  assert.match(active, /\nmaint\|New message\n/);
  assert.match(active, /RTENDMARKERBS1001/);
  const inactive = writeMaintenance(active, false, 'Back later');
  assert.match(inactive, /\n#maint\|Back later\n/);
});

test('maintenance writer adds a missing flag before the end marker', () => {
  const result = writeMaintenance('server|127.0.0.1\nRTENDMARKERBS1001', true, 'Updating');
  assert.match(result, /maint\|Updating\nRTENDMARKERBS1001/);
});

test('player IDs reject traversal and unsupported characters', () => {
  assert.equal(validatePlayerId('GrowID_01'), true);
  assert.equal(validatePlayerId('../players'), false);
  assert.equal(validatePlayerId('two words'), false);
  assert.equal(validatePlayerId(''), false);
});

test('numeric changes support add and set but never negative results', () => {
  assert.equal(applyNumericChange(100, 25, 'add'), 125);
  assert.equal(applyNumericChange(100, 25, 'set'), 25);
  assert.throws(() => applyNumericChange(5, -10, 'add'), /between 0/);
  assert.throws(() => applyNumericChange(5, 1, 'delete'), /Invalid operation/);
  assert.throws(() => applyNumericChange(5, 1.5, 'add'), /whole number/);
});

test('path guard and byte formatter handle expected values', () => {
  assert.equal(isInside('/srv/gtps/players', '/srv/gtps/players/a.json'), true);
  assert.equal(isInside('/srv/gtps/players', '/srv/gtps/worlds/a.json'), false);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
});

test('controller reads player files, keeps passwords private and creates backups', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtps-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const folder of ['players', 'worlds', 'gemdb']) await fs.mkdir(path.join(root, folder), { recursive: true });
  await fs.writeFile(path.join(root, 'players', 'TestGrow_.json'), JSON.stringify({
    gems: 10, wls: 4, xp: 120, level: 3, adminLevel: 0, password: 'not-for-the-browser'
  }));
  await fs.writeFile(path.join(root, 'gemdb', 'TestGrow.txt'), '900');
  await fs.writeFile(path.join(root, 'worlds', 'START.json'), '{}');
  await fs.writeFile(path.join(root, 'server_data.php'), 'server|127.0.0.1\n#maint|Closed\nRTENDMARKERBS1001');
  await fs.writeFile(path.join(root, 'online.txt'), '17');
  const controller = new GtpsController({
    paths: {
      players: './players', worlds: './worlds', gemDb: './gemdb',
      serverData: './server_data.php', onlineFile: './online.txt',
      backups: './backups', auditLog: './data/actions.log'
    },
    server: { processName: 'not-a-real-gtps-process-for-tests' }
  }, root);

  const overview = await controller.getOverview();
  assert.equal(overview.online, 17);
  assert.equal(overview.players.files, 1);
  assert.equal(overview.worlds.files, 1);
  const player = await controller.readPlayer('TestGrow');
  assert.equal(player.gems, 900);
  assert.equal(Object.hasOwn(player, 'password'), false);
  assert.equal((await controller.adjustPlayer('TestGrow', 'gems', 100, 'add')).value, 1000);
  assert.equal((await controller.adjustPlayer('TestGrow', 'wls', 3, 'add')).value, 7);
  assert.equal((await controller.readPlayer('TestGrow')).wls, 7);
  const backups = await fs.readdir(path.join(root, 'backups'));
  assert.equal(backups.length, 2);

  await controller.setMaintenance(true, 'Back in a bit');
  const serverData = await fs.readFile(path.join(root, 'server_data.php'), 'utf8');
  assert.match(serverData, /\nmaint\|Back in a bit\n/);
  const activity = await controller.getActivity();
  assert.equal(activity.length, 3);
});

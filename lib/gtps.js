'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

function isInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function validatePlayerId(value) {
  if (typeof value !== 'string') return false;
  const id = value.trim();
  return id.length > 0 && id.length <= 24 && id !== '.' && id !== '..' && /^[a-zA-Z0-9_.-]+$/.test(id);
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || Math.abs(number) > 1000000000) {
    throw new Error((label || 'Amount') + ' must be a whole number between -1,000,000,000 and 1,000,000,000.');
  }
  return number;
}

function applyNumericChange(currentValue, amountValue, operation) {
  const current = safeInteger(currentValue == null ? 0 : currentValue, 'Current value');
  const amount = safeInteger(amountValue, 'Amount');
  if (current < 0) throw new Error('Current value cannot be negative.');
  if (operation !== 'add' && operation !== 'set') throw new Error('Invalid operation.');
  const next = operation === 'add' ? current + amount : amount;
  if (!Number.isSafeInteger(next) || next < 0 || next > 1000000000) {
    throw new Error('The resulting value must be between 0 and 1,000,000,000.');
  }
  return next;
}

function readMaintenance(content) {
  const lines = String(content == null ? '' : content).split(/\r?\n/);
  const line = lines.find((entry) => /^\s*#?maint\|/i.test(entry));
  if (!line) return { enabled: false, message: '' };
  return {
    enabled: !/^\s*#maint\|/i.test(line),
    message: line.replace(/^\s*#?maint\|/i, '')
  };
}

function writeMaintenance(content, enabled, message) {
  const safeMessage = String(message == null ? '' : message).replace(/[\r\n]/g, ' ').trim().slice(0, 200);
  if (!safeMessage) throw new Error('Maintenance message cannot be empty.');
  const lines = String(content == null ? '' : content).split(/\r?\n/);
  const index = lines.findIndex((entry) => /^\s*#?maint\|/i.test(entry));
  const replacement = (enabled ? '' : '#') + 'maint|' + safeMessage;
  if (index >= 0) lines[index] = replacement;
  else {
    const marker = lines.findIndex((entry) => /^RTENDMARKERBS1001\s*$/i.test(entry));
    if (marker >= 0) lines.splice(marker, 0, replacement);
    else lines.push(replacement);
  }
  return lines.join('\n');
}

async function walkDirectory(directory, maxEntries) {
  let files = 0;
  let bytes = 0;
  let entries = 0;
  async function visit(current, depth) {
    if (depth > 12 || entries >= maxEntries) return;
    let dirents;
    try { dirents = await fs.promises.readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const dirent of dirents) {
      entries += 1;
      if (entries >= maxEntries) break;
      const full = path.join(current, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) await visit(full, depth + 1);
      else if (dirent.isFile()) {
        files += 1;
        try { bytes += (await fs.promises.stat(full)).size; } catch {}
      }
    }
  }
  await visit(directory, 0);
  return { files, bytes };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}

class GtpsController {
  constructor(config, rootDirectory) {
    this.config = config;
    this.rootDirectory = path.resolve(rootDirectory || process.cwd());
    this.paths = {};
    const configured = config.paths || {};
    for (const key of Object.keys(configured)) {
      const value = configured[key];
      if (typeof value === 'string' && value.trim()) this.paths[key] = path.resolve(this.rootDirectory, value);
    }
    this.serverWorkingDirectory = path.resolve(this.rootDirectory, configured.serverWorkingDirectory || '.');
    this.serverExecutable = this.paths.serverExecutable || path.resolve(this.rootDirectory, './server.exe');
    this.processName = path.basename((config.server && config.server.processName) || this.serverExecutable);
    this.child = null;
  }

  async backupFile(filePath) {
    const directory = this.paths.backups || path.join(this.rootDirectory, 'backups');
    await fs.promises.mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(directory, path.basename(filePath) + '.' + stamp + '.bak');
    await fs.promises.copyFile(filePath, destination);
    return destination;
  }

  async writeFileAtomic(filePath, content) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
    await fs.promises.writeFile(temp, content, 'utf8');
    await fs.promises.rename(temp, filePath);
  }

  async audit(action, detail) {
    const file = this.paths.auditLog || path.join(this.rootDirectory, 'data', 'admin-actions.log');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const entry = Object.assign({ at: new Date().toISOString(), action: action }, detail || {});
    await fs.promises.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
  }

  async getDirectoryStats(directory) {
    try {
      const stat = await fs.promises.stat(directory);
      if (!stat.isDirectory()) return { files: 0, bytes: 0, available: false };
      return Object.assign(await walkDirectory(directory, 50000), { available: true });
    } catch {
      return { files: 0, bytes: 0, available: false };
    }
  }

  async getOnlineCount() {
    if (!this.paths.onlineFile) return null;
    try {
      const raw = (await fs.promises.readFile(this.paths.onlineFile, 'utf8')).trim();
      const match = raw.match(/\d+/);
      return match ? Number(match[0]) : null;
    } catch { return null; }
  }

  async getServerStatus() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return { running: true, managed: true, pid: this.child.pid || null };
    }
    try {
      if (process.platform === 'win32') {
        const result = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq ' + this.processName, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 });
        const escaped = this.processName.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
        const match = result.stdout.match(new RegExp('^"' + escaped + '"\\s*,\\s*"?(\\d+)', 'im'));
        return { running: Boolean(match), managed: false, pid: match ? Number(match[1]) : null };
      }
      const result = await execFileAsync('pgrep', ['-x', this.processName], { timeout: 5000 });
      const pid = Number(result.stdout.trim().split(/\s+/)[0]);
      return { running: Number.isInteger(pid) && pid > 0, managed: false, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
    } catch { return { running: false, managed: false, pid: null }; }
  }

  async startServer() {
    const status = await this.getServerStatus();
    if (status.running) throw new Error('Server is already running.');
    await fs.promises.access(this.serverExecutable).catch(() => {
      throw new Error('Server executable was not found. Check paths.serverExecutable in config.json.');
    });
    const child = spawn(this.serverExecutable, [], {
      cwd: this.serverWorkingDirectory,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    });
    this.child = child;
    child.once('exit', () => { if (this.child === child) this.child = null; });
    child.unref();
    await this.audit('server.start', { pid: child.pid || null });
    return { message: 'Start command sent.', pid: child.pid || null };
  }

  async stopServer() {
    const status = await this.getServerStatus();
    if (!status.running) throw new Error('Server is not running.');
    if (this.child && status.managed) {
      const child = this.child;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (this.child === child && child.exitCode === null) child.kill('SIGKILL');
      this.child = null;
    } else if (process.platform === 'win32') {
      await execFileAsync('taskkill.exe', ['/PID', String(status.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else {
      process.kill(status.pid, 'SIGTERM');
    }
    await this.audit('server.stop', { pid: status.pid });
    return { message: 'Stop command sent.' };
  }

  async serverAction(action) {
    if (action === 'start') return this.startServer();
    if (action === 'stop') return this.stopServer();
    if (action === 'restart') {
      await this.stopServer();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return this.startServer();
    }
    throw new Error('Unknown server action.');
  }

  async getOverview() {
    const results = await Promise.all([
      this.getServerStatus(),
      this.getOnlineCount(),
      this.getDirectoryStats(this.paths.players || ''),
      this.getDirectoryStats(this.paths.worlds || ''),
      this.paths.serverData ? fs.promises.readFile(this.paths.serverData, 'utf8').catch(() => null) : Promise.resolve(null)
    ]);
    const players = results[2];
    const worlds = results[3];
    const maintenanceContent = results[4];
    return {
      server: results[0],
      online: results[1],
      players: Object.assign({}, players, { size: formatBytes(players.bytes) }),
      worlds: Object.assign({}, worlds, { size: formatBytes(worlds.bytes) }),
      maintenance: maintenanceContent === null
        ? { enabled: false, message: '', configured: false }
        : Object.assign(readMaintenance(maintenanceContent), { configured: true }),
      dashboardUptime: Math.floor(process.uptime())
    };
  }

  async getActivity(limit) {
    const file = this.paths.auditLog;
    if (!file) return [];
    try {
      const lines = (await fs.promises.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(Number(limit) || 40, 100))).reverse().map((line) => {
        try { return JSON.parse(line); } catch { return { action: 'log.entry', detail: line }; }
      });
    } catch { return []; }
  }

  async getServerLog(limit) {
    const file = this.paths.serverLog;
    if (!file) return [];
    try {
      const lines = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(Number(limit) || 100, 300)));
    } catch { return []; }
  }

  async listPlayerFiles() {
    if (!this.paths.players) throw new Error('Player folder is not configured.');
    const entries = await fs.promises.readdir(this.paths.players, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'));
  }

  async findPlayerFile(id) {
    if (!validatePlayerId(id)) throw new Error('Invalid GrowID.');
    if (!this.paths.players) throw new Error('Player folder is not configured.');
    const base = this.paths.players;
    for (const name of [id.trim() + '.json', id.trim() + '_.json']) {
      const file = path.resolve(base, name);
      if (!isInside(base, file)) continue;
      try {
        if ((await fs.promises.stat(file)).isFile()) return file;
      } catch {}
    }
    throw new Error('Player was not found.');
  }

  async readPlayer(id) {
    const file = await this.findPlayerFile(id);
    const player = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    let gems = Number(player.gems || 0);
    const gemFile = this.paths.gemDb ? path.join(this.paths.gemDb, id.trim() + '.txt') : null;
    if (gemFile) {
      try { gems = safeInteger((await fs.promises.readFile(gemFile, 'utf8')).trim(), 'Gems'); } catch {}
    }
    return {
      id: id.trim(),
      gems: Number.isFinite(gems) ? gems : 0,
      wls: Number(player.wls || 0),
      xp: Number(player.xp || 0),
      level: Number(player.level || 0),
      adminLevel: Number(player.adminLevel || 0)
    };
  }

  async searchPlayers(query) {
    const entries = await this.listPlayerFiles();
    const needle = String(query || '').trim().toLowerCase();
    const matches = entries.map((entry) => ({
      id: entry.name.replace(/\.json$/i, '').replace(/_$/, '')
    })).filter((item) => validatePlayerId(item.id) && (!needle || item.id.toLowerCase().includes(needle))).slice(0, 30);
    const output = [];
    for (const item of matches) {
      try {
        const player = await this.readPlayer(item.id);
        output.push({ id: player.id, gems: player.gems, wls: player.wls, level: player.level });
      } catch {}
    }
    return output;
  }

  async adjustPlayer(id, field, amount, operation) {
    const allowed = ['gems', 'wls', 'xp', 'level', 'adminLevel'];
    if (!allowed.includes(field)) throw new Error('This player field cannot be changed.');
    const file = await this.findPlayerFile(id);
    const player = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const current = await this.readPlayer(id);
    const next = applyNumericChange(current[field], amount, operation || 'add');
    const gemFile = this.paths.gemDb ? path.join(this.paths.gemDb, id.trim() + '.txt') : null;
    if (field === 'gems' && gemFile) {
      try {
        await fs.promises.access(gemFile);
        await this.backupFile(gemFile);
        await this.writeFileAtomic(gemFile, String(next));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        player.gems = next;
        await this.backupFile(file);
        await this.writeFileAtomic(file, JSON.stringify(player, null, 2));
      }
    } else {
      player[field] = next;
      await this.backupFile(file);
      await this.writeFileAtomic(file, JSON.stringify(player, null, 2));
    }
    await this.audit('player.update', { player: id, field: field, operation: operation || 'add', value: next });
    return { id: id, field: field, value: next };
  }

  async setMaintenance(enabled, message) {
    if (!this.paths.serverData) throw new Error('server_data.php path is not configured.');
    const file = this.paths.serverData;
    const original = await fs.promises.readFile(file, 'utf8');
    const next = writeMaintenance(original, enabled, message || (this.config.server && this.config.server.maintenanceMessage));
    await this.backupFile(file);
    await this.writeFileAtomic(file, next);
    await this.audit('server.maintenance', { enabled: enabled, message: String(message || '').slice(0, 200) });
    return { enabled: enabled, message: readMaintenance(next).message };
  }
}

module.exports = {
  GtpsController,
  applyNumericChange,
  formatBytes,
  isInside,
  readMaintenance,
  validatePlayerId,
  writeMaintenance
};

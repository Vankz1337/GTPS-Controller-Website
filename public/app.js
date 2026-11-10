'use strict';

let csrfToken = '';
let selectedPlayer = '';
let toastTimer = null;
let confirmHandler = null;
const $ = (selector) => document.querySelector(selector);

async function api(url, options) {
  const settings = Object.assign({ method: 'GET', credentials: 'same-origin' }, options || {});
  settings.headers = Object.assign({}, settings.headers || {});
  if (settings.body) settings.headers['Content-Type'] = 'application/json';
  if (settings.method !== 'GET' && url !== '/api/login' && csrfToken) settings.headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, settings);
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showLogin();
    throw new Error(payload.error || 'Request failed (' + response.status + ').');
  }
  return payload;
}

function showToast(message, error) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', Boolean(error));
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function showLogin() {
  csrfToken = '';
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  $('#login-password').value = '';
}

function showApp(username) {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#user-name').textContent = username || 'Admin';
  $('#user-name').title = username || 'Admin';
}

function setView(name) {
  const titles = { overview: 'Overview', players: 'Players', server: 'Server management', activity: 'Activity log' };
  document.querySelectorAll('.page-view').forEach((section) => section.classList.add('hidden'));
  const section = $('#view-' + name);
  if (section) section.classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $('#page-title').textContent = titles[name] || 'Overview';
  if (name === 'activity') refreshActivity().catch((error) => showToast(error.message, true));
  if (name === 'server') refreshServerLog().catch(() => {});
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en-US').format(Number(value));
}

function formatUptime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days) return days + 'd ' + hours + 'h';
  if (hours) return hours + 'h ' + minutes + 'm';
  return minutes + 'm';
}

function timeAgo(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString();
}

function makeActivityItem(item) {
  const row = document.createElement('div');
  row.className = 'activity-item';
  const mark = document.createElement('div');
  mark.className = 'activity-mark';
  mark.textContent = item.action && item.action.startsWith('server') ? '▤' : '·';
  const content = document.createElement('div');
  content.className = 'activity-text';
  const title = document.createElement('strong');
  title.textContent = String(item.action || 'Activity').replace(/[._]/g, ' ');
  const detail = document.createElement('small');
  const bits = [];
  if (item.player) bits.push('Player ' + item.player);
  if (item.field) bits.push(item.field + ': ' + item.value);
  if (typeof item.enabled === 'boolean') bits.push(item.enabled ? 'Enabled' : 'Disabled');
  if (item.username) bits.push(item.username);
  detail.textContent = bits.join(' · ') || 'Action recorded';
  const time = document.createElement('time');
  time.className = 'activity-time';
  time.textContent = timeAgo(item.at);
  content.append(title, detail);
  row.append(mark, content, time);
  return row;
}

function renderActivity(container, items) {
  container.replaceChildren();
  if (!items || !items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No activity has been recorded yet.';
    container.append(empty);
    return;
  }
  items.forEach((item) => container.append(makeActivityItem(item)));
}

async function refreshOverview() {
  const data = await api('/api/overview');
  const running = Boolean(data.server && data.server.running);
  $('#online-count').textContent = formatNumber(data.online);
  $('#player-count').textContent = formatNumber(data.players && data.players.files);
  $('#player-size').textContent = (data.players && data.players.size || 'Folder not available') + ' stored';
  $('#world-count').textContent = formatNumber(data.worlds && data.worlds.files);
  $('#world-size').textContent = (data.worlds && data.worlds.size || 'Folder not available') + ' stored';
  $('#uptime').textContent = formatUptime(data.dashboardUptime);
  $('#server-status-text').textContent = running ? 'Server is running' : 'Server is offline';
  $('#server-pill').classList.toggle('down', !running);
  $('#server-page-pill').textContent = running ? 'Running' : 'Offline';
  $('#control-status-title').textContent = running ? 'Server is online' : 'Server is offline';
  $('#control-status-note').textContent = data.server && data.server.pid ? 'Process ID ' + data.server.pid : 'No running process detected';
  $('#server-orb').classList.toggle('down', !running);
  const maintenance = data.maintenance || { enabled: false, message: '' };
  const badgeText = maintenance.enabled ? 'Enabled' : 'Disabled';
  ['#maintenance-badge', '#maintenance-badge-server'].forEach((selector) => {
    const badge = $(selector);
    badge.textContent = badgeText;
    badge.className = 'tag ' + (maintenance.enabled ? 'tag-on' : 'tag-off');
  });
  $('#maintenance-message').value = maintenance.message || '';
  $('#maintenance-message-server').value = maintenance.message || '';
  $('#last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  $('#control-status-title').dataset.running = String(running);
}

async function refreshActivity() {
  const data = await api('/api/activity');
  renderActivity($('#activity-list'), data.items);
  renderActivity($('#overview-activity'), (data.items || []).slice(0, 4));
}

async function refreshServerLog() {
  const data = await api('/api/server-log');
  $('#server-log').textContent = (data.lines || []).join('\n') || 'No log entries found. Check paths.serverLog in config.json.';
}

async function refreshAll() {
  await refreshOverview();
  await refreshActivity();
}

async function findPlayers(query) {
  const data = await api('/api/players?q=' + encodeURIComponent(query || ''));
  const container = $('#player-results');
  container.replaceChildren();
  if (!data.items || !data.items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No matching player account found.';
    container.append(empty);
    return;
  }
  data.items.forEach((player) => {
    const row = document.createElement('div');
    row.className = 'player-result';
    const name = document.createElement('strong');
    name.textContent = player.id;
    const gems = document.createElement('span');
    gems.textContent = formatNumber(player.gems) + ' gems';
    const wls = document.createElement('span');
    wls.textContent = formatNumber(player.wls) + ' WL';
    const level = document.createElement('span');
    level.textContent = 'Lv. ' + formatNumber(player.level);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Open';
    button.addEventListener('click', () => loadPlayer(player.id).catch((error) => showToast(error.message, true)));
    row.append(name, gems, wls, level, button);
    container.append(row);
  });
}

async function loadPlayer(id) {
  const player = await api('/api/players/' + encodeURIComponent(id));
  selectedPlayer = player.id;
  $('#selected-player-name').textContent = player.id;
  const stats = $('#player-stats');
  stats.replaceChildren();
  [
    ['Gems', player.gems],
    ['World Locks', player.wls],
    ['XP', player.xp],
    ['Level', player.level],
    ['Role level', player.adminLevel]
  ].forEach(([label, value]) => {
    const card = document.createElement('div');
    card.className = 'player-stat';
    const caption = document.createElement('small');
    caption.textContent = label;
    const number = document.createElement('strong');
    number.textContent = formatNumber(value);
    card.append(caption, number);
    stats.append(card);
  });
  $('#player-detail').classList.remove('hidden');
}

function askConfirm(title, message, handler, actionLabel) {
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-accept').textContent = actionLabel || 'Continue';
  confirmHandler = handler;
  $('#confirm-modal').classList.remove('hidden');
}

function closeConfirm() {
  $('#confirm-modal').classList.add('hidden');
  confirmHandler = null;
}

async function runServerAction(action) {
  const labels = { start: 'Start server', stop: 'Stop server', restart: 'Restart server' };
  const messages = {
    start: 'Start the configured GTPS executable?',
    stop: 'Stop the running GTPS process?',
    restart: 'Stop the current process and start it again?'
  };
  askConfirm(labels[action], messages[action], async () => {
    await api('/api/server/action', { method: 'POST', body: JSON.stringify({ action: action }) });
    showToast(labels[action] + ' command sent.');
    await refreshOverview();
  }, labels[action]);
}

async function saveMaintenance(enabled) {
  const message = ($('#maintenance-message').value || $('#maintenance-message-server').value).trim();
  if (!message) {
    showToast('Enter a maintenance message first.', true);
    return;
  }
  askConfirm(enabled ? 'Enable maintenance mode' : 'Disable maintenance mode', enabled
    ? 'Players will receive the maintenance message from server_data.php.'
    : 'The maintenance flag will be commented out in server_data.php.', async () => {
    await api('/api/maintenance', { method: 'POST', body: JSON.stringify({ enabled: enabled, message: message }) });
    showToast('Maintenance ' + (enabled ? 'enabled' : 'disabled') + '. Backup created.');
    await refreshOverview();
    await refreshActivity();
  }, enabled ? 'Enable' : 'Disable');
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-form button[type="submit"]');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#login-username').value.trim(),
        password: $('#login-password').value
      })
    });
    csrfToken = result.csrf;
    showApp(result.username);
    await refreshAll();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout-button').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    showLogin();
  } catch (error) { showToast(error.message, true); }
});

$('#refresh-button').addEventListener('click', () => refreshAll().catch((error) => showToast(error.message, true)));
$('#log-refresh').addEventListener('click', () => refreshServerLog().catch((error) => showToast(error.message, true)));

document.querySelectorAll('.nav-link').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});
document.querySelectorAll('[data-go-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.goView));
});
document.querySelectorAll('[data-server-action]').forEach((button) => {
  button.addEventListener('click', () => runServerAction(button.dataset.serverAction).catch((error) => showToast(error.message, true)));
});

$('#maintenance-on').addEventListener('click', () => saveMaintenance(true));
$('#maintenance-off').addEventListener('click', () => saveMaintenance(false));
$('#maintenance-on-server').addEventListener('click', () => {
  $('#maintenance-message').value = $('#maintenance-message-server').value;
  saveMaintenance(true);
});
$('#maintenance-off-server').addEventListener('click', () => {
  $('#maintenance-message').value = $('#maintenance-message-server').value;
  saveMaintenance(false);
});

$('#player-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  findPlayers($('#player-search').value).catch((error) => showToast(error.message, true));
});
$('#player-search').addEventListener('input', () => {
  const query = $('#player-search').value.trim();
  if (query.length >= 2) findPlayers(query).catch(() => {});
  else $('#player-results').replaceChildren();
});

$('#player-edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!selectedPlayer) return;
  const field = $('#edit-field').value;
  const amount = $('#edit-amount').value;
  const operation = $('#edit-operation').value;
  askConfirm('Apply player change', 'Update ' + selectedPlayer + ' — ' + field + ' (' + operation + ' ' + amount + ')?', async () => {
    const result = await api('/api/players/' + encodeURIComponent(selectedPlayer), {
      method: 'POST',
      body: JSON.stringify({ field: field, amount: amount, operation: operation })
    });
    showToast(field + ' updated to ' + formatNumber(result.value) + '. Backup created.');
    $('#edit-amount').value = '';
    await loadPlayer(selectedPlayer);
    await refreshActivity();
  }, 'Apply change');
});

$('#confirm-cancel').addEventListener('click', closeConfirm);
$('#confirm-modal').addEventListener('click', (event) => {
  if (event.target.id === 'confirm-modal') closeConfirm();
});
$('#confirm-accept').addEventListener('click', async () => {
  const handler = confirmHandler;
  closeConfirm();
  if (!handler) return;
  try { await handler(); }
  catch (error) { showToast(error.message, true); }
});

async function boot() {
  try {
    const session = await api('/api/session');
    csrfToken = session.csrf;
    showApp(session.username);
    await refreshAll();
  } catch { showLogin(); }
}
boot();

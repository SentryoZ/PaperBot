'use strict';
/* Minecraft Test-Bot Manager — SPA controller (vanilla JS, no build step).
 * Talks to the REST API and the /ws event stream from src/server.js. */

(() => {
  const $ = (sel) => document.querySelector(sel);
  const api = {
    base: '',
    async call(path, opts = {}) {
      const res = await fetch(this.base + path, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
      let body = null;
      const text = await res.text();
      if (text) { try { body = JSON.parse(text); } catch { body = { raw: text }; } }
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      return body;
    },
    get: (p) => api.call(p),
    post: (p, data) => api.call(p, { method: 'POST', body: JSON.stringify(data || {}) }),
    put: (p, data) => api.call(p, { method: 'PUT', body: JSON.stringify(data || {}) }),
    del: (p) => api.call(p, { method: 'DELETE' }),
  };

  const state = {
    settings: null,
    bots: new Map(),      // id -> {id,name,state,error}
    selected: new Set(),  // bot ids checked in the list
    chatFilter: '__all__',
    messages: [],         // {ts,type,botId,name,text}
    ws: null,
    wsUp: false,
    apiUp: false,
  };

  // ── small helpers ────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtTime = (ts) => new Date(ts || Date.now()).toTimeString().slice(0, 8);
  const MAX_MESSAGES = 500;

  function toast(msg, kind = '') {
    let wrap = $('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ` toast--${kind}` : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ── status pills ─────────────────────────────────────────────────
  function setApi(up) {
    state.apiUp = up;
    $('#api-state').textContent = up ? 'OK' : 'down';
    $('#api-pill').className = 'pill ' + (up ? 'pill--up' : 'pill--down');
  }
  function setWs(up) {
    state.wsUp = up;
    $('#ws-state').textContent = up ? 'connected' : 'offline';
    $('#ws-pill').className = 'pill ' + (up ? 'pill--up' : 'pill--down');
  }
  function renderCounts() {
    const up = [...state.bots.values()].filter((b) => b.state === 'spawned' || b.state === 'connected').length;
    $('#bot-count').textContent = String(up);
  }

  // ── settings ─────────────────────────────────────────────────────
  function fillSettings(s) {
    state.settings = s;
    $('#set-host').value = s.host ?? '';
    $('#set-port').value = s.port ?? '';
    $('#set-version').value = s.version ?? '';
    $('#set-acceptrp').checked = s.acceptResourcePack !== false;
    $('#set-prefix').value = s.nicknamePrefix ?? '';
    $('#set-nickmode').value = s.nicknameMode || 'random';
    $('#set-delaymin').value = s.connectDelayMin ?? 0;
    $('#set-delaymax').value = s.connectDelayMax ?? 0;
  }

  function readSettingsForm() {
    return {
      host: $('#set-host').value.trim(),
      port: Number($('#set-port').value),
      version: $('#set-version').value.trim(),
      acceptResourcePack: $('#set-acceptrp').checked,
      nicknamePrefix: $('#set-prefix').value.trim(),
      nicknameMode: $('#set-nickmode').value,
      connectDelayMin: Number($('#set-delaymin').value),
      connectDelayMax: Number($('#set-delaymax').value),
    };
  }

  async function loadSettings() {
    try {
      fillSettings(await api.get('/api/settings'));
      $('#settings-state').textContent = 'loaded';
    } catch (err) {
      $('#settings-state').textContent = 'unavailable';
      toast('Could not load settings: ' + err.message, 'error');
    }
  }

  async function saveSettings(ev) {
    ev.preventDefault();
    const patch = readSettingsForm();
    if (!patch.host || !Number.isFinite(patch.port)) { toast('Host and port are required', 'error'); return; }
    try {
      fillSettings(await api.put('/api/settings', patch));
      $('#settings-state').textContent = 'saved ' + fmtTime();
      toast('Settings saved', 'ok');
    } catch (err) {
      toast('Save failed: ' + err.message, 'error');
    }
  }

  // ── bots ─────────────────────────────────────────────────────────
  function setBots(list) {
    state.bots.clear();
    for (const b of list || []) state.bots.set(b.id, { id: b.id, name: b.name, state: b.state, error: b.error || null });
    for (const id of [...state.selected]) if (!state.bots.has(id)) state.selected.delete(id);
    renderBots();
    renderFilterOptions();
  }

  function upsertBot(evt) {
    const prev = state.bots.get(evt.botId) || { id: evt.botId };
    state.bots.set(evt.botId, {
      id: evt.botId,
      name: evt.name || prev.name || evt.botId,
      state: evt.state,
      error: evt.error || null,
    });
    renderBots();
    renderFilterOptions();
  }

  function renderBots() {
    const list = $('#bot-list');
    const bots = [...state.bots.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!bots.length) {
      list.innerHTML = '<li class="empty">No bots yet — add some above.</li>';
      renderSelectionSummary();
      renderCounts();
      return;
    }
    list.innerHTML = bots.map((b) => `
      <li class="bot bot--${esc(b.state)}" data-id="${esc(b.id)}">
        <input class="bot__sel" type="checkbox" data-id="${esc(b.id)}" ${state.selected.has(b.id) ? 'checked' : ''} title="Select for targeted actions" />
        <span class="bot__name" title="${esc(b.name)}">${esc(b.name)}</span>
        ${b.error ? `<span class="bot__error" title="${esc(b.error)}">${esc(b.error)}</span>` : ''}
        <span class="bot__state">${esc(b.state)}</span>
        <button class="btn btn--ghost btn--sm bot__disconnect" data-id="${esc(b.id)}" title="Disconnect this bot">✕</button>
      </li>`).join('');
    renderSelectionSummary();
    renderCounts();
  }

  function renderSelectionSummary() {
    const n = state.selected.size;
    $('#selected-summary').textContent = n ? `${n} selected` : 'all bots';
  }

  function renderFilterOptions() {
    const sel = $('#chat-filter');
    const keep = state.chatFilter;
    const bots = [...state.bots.values()].sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="__all__">Combined (all bots)</option>' +
      bots.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
    state.chatFilter = (keep === '__all__' || state.bots.has(keep)) ? keep : '__all__';
    sel.value = state.chatFilter;
  }

  async function reloadBots() {
    try {
      setBots((await api.get('/api/bots')).bots || []);
    } catch (err) {
      toast('Could not load bots: ' + err.message, 'error');
    }
  }

  const parseNames = (raw) => String(raw || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

  async function addBots(ev) {
    ev.preventDefault();
    const names = parseNames($('#add-names').value);
    const randomNames = $('#add-random').checked;
    let count = Math.max(1, parseInt($('#add-count').value, 10) || 1);
    if (names.length > count) count = names.length;
    const mode = state.settings && state.settings.nicknameMode;
    if (mode === 'custom' && !names.length) {
      toast('Custom-list mode is on — enter names below.', 'error');
      return;
    }
    const payload = {
      count,
      randomNames,
      names: names.length ? names : undefined,
      prefix: (state.settings && state.settings.nicknamePrefix) || undefined,
    };
    const btn = ev.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const data = await api.post('/api/bots', payload);
      setBots(data.bots || []);
      toast(`Added ${(data.created || []).length} bot(s)`, 'ok');
    } catch (err) {
      toast('Add failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function disconnectBot(id) {
    try {
      setBots((await api.del('/api/bots/' + encodeURIComponent(id))).bots || []);
    } catch (err) {
      toast('Disconnect failed: ' + err.message, 'error');
    }
  }

  async function disconnectAll() {
    if (!state.bots.size) { toast('No bots to disconnect'); return; }
    try {
      const data = await api.post('/api/bots/disconnect-all', {});
      setBots(data.bots || []);
      toast(`Disconnected ${data.count ?? 0} bot(s)`, 'ok');
    } catch (err) {
      toast('Disconnect all failed: ' + err.message, 'error');
    }
  }

  // ── chat / commands ──────────────────────────────────────────────
  function targetBotIds() {
    if ($('#send-to-selected').checked && state.selected.size) return [...state.selected];
    return undefined; // all bots
  }

  async function sendChat(ev) {
    if (ev) ev.preventDefault();
    const input = $('#chat-input');
    const message = input.value.trim();
    if (!message) return;
    try {
      const r = await api.post('/api/chat', { message, botIds: targetBotIds() });
      if (!r.count) toast('No connected bots to receive the chat', 'error');
      else input.value = '';
    } catch (err) {
      toast('Chat failed: ' + err.message, 'error');
    }
  }

  async function sendCommand(ev) {
    if (ev) ev.preventDefault();
    const input = $('#command-input');
    let command = input.value.trim();
    if (!command) return;
    if (!command.startsWith('/')) command = '/' + command;
    try {
      const r = await api.post('/api/command', { command, botIds: targetBotIds() });
      if (!r.count) toast('No connected bots to run the command', 'error');
      else input.value = '';
    } catch (err) {
      toast('Command failed: ' + err.message, 'error');
    }
  }

  function lineClass(type, position) {
    if (type === 'error') return 'line--error';
    if (type === 'log') return 'line--log';
    if (type === 'system') return 'line--system';
    if (position === 'whisper' || position === 'msg') return 'line--whisper';
    return 'line--chat';
  }

  function lineHtml(m) {
    const who = m.name || (m.type === 'log' ? (m.level || 'log') : m.type);
    return `<div class="line ${lineClass(m.type, m.position)}">
      <span class="line__ts">${esc(fmtTime(m.ts))}</span>
      <span class="line__who">${esc(who)}</span>
      <span class="line__msg">${esc(m.text)}</span>
    </div>`;
  }

  const visible = (m) => state.chatFilter === '__all__' || m.botId === state.chatFilter;

  function appendLine(m) {
    if (!visible(m)) return;
    const log = $('#chat-log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.insertAdjacentHTML('beforeend', lineHtml(m));
    while (log.children.length > MAX_MESSAGES) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function addMessage(m) {
    state.messages.push(m);
    if (state.messages.length > MAX_MESSAGES) state.messages.shift();
    appendLine(m);
  }

  function rerenderChat() {
    const log = $('#chat-log');
    log.innerHTML = state.messages.filter(visible).map(lineHtml).join('');
    log.scrollTop = log.scrollHeight;
  }

  // ── websocket ────────────────────────────────────────────────────
  let wsBackoff = 1000;
  let wsTimer = null;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
    catch { setWs(false); return scheduleWsReconnect(); }
    state.ws = ws;
    ws.addEventListener('open', () => { wsBackoff = 1000; setWs(true); });
    ws.addEventListener('close', () => { setWs(false); scheduleWsReconnect(); });
    ws.addEventListener('error', () => setWs(false));
    ws.addEventListener('message', (e) => {
      let evt; try { evt = JSON.parse(e.data); } catch { return; }
      handleEvent(evt);
    });
  }

  function scheduleWsReconnect() {
    if (wsTimer) return;
    wsTimer = setTimeout(() => {
      wsTimer = null;
      wsBackoff = Math.min(wsBackoff * 1.5, 8000);
      connectWs();
    }, wsBackoff);
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case 'status':
        if (evt.settings) fillSettings(evt.settings);
        if (Array.isArray(evt.bots)) setBots(evt.bots);
        break;
      case 'bot_state':
        upsertBot(evt);
        break;
      case 'chat':
        addMessage({ ts: evt.ts, type: 'chat', botId: evt.botId, name: evt.name, position: evt.position, text: evt.message });
        break;
      case 'system':
        addMessage({ ts: evt.ts, type: 'system', botId: evt.botId, name: evt.name, text: evt.message });
        break;
      case 'log':
        addMessage({ ts: evt.ts, type: evt.level === 'error' ? 'error' : 'log', botId: evt.botId, name: evt.name, level: evt.level, text: evt.message });
        break;
      default:
        break;
    }
  }

  // ── API reachability poll ────────────────────────────────────────
  async function pollStatus() {
    try {
      const s = await api.get('/api/status');
      setApi(true);
      if (s.settings) fillSettings(s.settings);
    } catch {
      setApi(false);
    }
  }

  // ── wiring ───────────────────────────────────────────────────────
  function wire() {
    $('#settings-form').addEventListener('submit', saveSettings);
    $('#settings-reload').addEventListener('click', loadSettings);
    $('#add-form').addEventListener('submit', addBots);
    $('#btn-disconnect-all').addEventListener('click', disconnectAll);

    $('#bot-list').addEventListener('change', (e) => {
      const cb = e.target.closest('.bot__sel');
      if (!cb) return;
      if (cb.checked) state.selected.add(cb.dataset.id); else state.selected.delete(cb.dataset.id);
      renderSelectionSummary();
    });
    $('#bot-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.bot__disconnect');
      if (btn) disconnectBot(btn.dataset.id);
    });

    $('#chat-filter').addEventListener('change', (e) => { state.chatFilter = e.target.value; rerenderChat(); });
    $('#btn-clear-chat').addEventListener('click', () => { state.messages = []; $('#chat-log').innerHTML = ''; });

    $('#btn-send-chat').addEventListener('click', sendChat);
    $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(e); });
    $('#btn-send-command').addEventListener('click', sendCommand);
    $('#command-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCommand(e); });
  }

  async function boot() {
    wire();
    connectWs();
    await pollStatus();
    await loadSettings();
    await reloadBots();
    setInterval(pollStatus, 5000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

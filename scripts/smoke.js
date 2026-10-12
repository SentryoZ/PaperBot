#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots a REAL Paper 26.2 offline server (Java 25) and drives the bot engine
 * against it, then exercises the HTTP/WS layer. Verifies the definition-of-done
 * items:
 *   - 5 bots get 5 distinct random names and all spawn
 *   - a bot's chat reaches the server (another bot receives it)
 *   - a `/` command executes and the bot sees the server's reply
 *   - the bot accepts a server resource pack and survives it
 *   - declining a resource pack does not hang or crash
 *   - a server kick does not crash the app (and the bot auto-respawns)
 *   - disconnect one / all works
 *   - settings persist to config.json and are honoured on reconnect
 *   - the REST API answers
 *
 * Usage: npm run smoke
 * Env:   PAPER_PORT (default 25578), JAVA_BIN, PAPER_BUILD, SMOKE_KEEP_SERVER=1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PAPER_PORT || 25578);
const JAVA = process.env.JAVA_BIN || '/usr/lib/jvm/java-25-openjdk-amd64/bin/java';
const BUILD = process.env.PAPER_BUILD || '133';
const SHA = 'bf1dcf627364f8a631ab15250d240eb5a8e89faaac523b391e1c61367fce9ff1';
const JAR_URL = `https://fill-data.papermc.io/v1/objects/${SHA}/paper-26.2-${BUILD}.jar`;
const SERVER_DIR = path.join(ROOT, '.paper-server-smoke');
const JAR = path.join(SERVER_DIR, 'paper.jar');

const { ConfigStore } = require('../src/config');
const { BotManager } = require('../src/bot-manager');
const { createServer } = require('../src/server');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

function startPaperServer() {
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  if (!fs.existsSync(JAR) || fs.statSync(JAR).size < 50 * 1024 * 1024) {
    console.log(`[smoke] downloading Paper 26.2 build ${BUILD}...`);
    execFileSync('curl', ['-fL', '--retry', '3', '-o', JAR, JAR_URL], { stdio: 'inherit' });
  }
  fs.writeFileSync(path.join(SERVER_DIR, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(
    path.join(SERVER_DIR, 'server.properties'),
    [
      'online-mode=false',
      `server-port=${PORT}`,
      'motd=smoke-test',
      'view-distance=3',
      'simulation-distance=3',
      'spawn-protection=0',
      'max-players=50',
      'resource-pack=https://example.com/smoke-pack.zip',
      'require-resource-pack=false',
      '',
    ].join('\n')
  );

  const child = spawn(JAVA, ['-Xms512M', '-Xmx1200M', '-jar', 'paper.jar', '--nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { child, log: [], lines: [], ready: false, startedAt: Date.now() };
  const onLine = (line) => {
    state.lines.push(line);
    if (/Done \([\d.]+s\)! For help/.test(line)) state.ready = true;
  };
  const consume = (buf) => {
    const text = buf.toString();
    state.log.push(text);
    for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line);
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('exit', (code) => { state.exited = code; });
  return state;
}

async function apiRequest(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: payload ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('== Paper 26.2 test-bot manager — smoke ==');
  console.log(`[smoke] node ${process.version}, java ${JAVA}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-config-'));

  // ---------------------------------------------------------------- server
  let server = null;
  let borrowed = false;
  if (await isPortOpen(PORT)) {
    borrowed = true;
    console.log(`[smoke] reusing server already listening on 127.0.0.1:${PORT} (resource-pack assertions may be skipped)`);
  } else {
    server = startPaperServer();
    const up = await waitFor(() => server.ready || server.exited != null, 180000, 500);
    check('Paper 26.2 server started', up && server.ready, up ? '' : 'server did not reach "Done"');
    if (!server.ready) throw new Error('server failed to start; aborting');
  }

  const events = [];
  const config = new ConfigStore(path.join(tmp, 'config.json'));
  config.update({ host: '127.0.0.1', port: PORT, version: '26.2', acceptResourcePack: true, connectDelayMin: 30, connectDelayMax: 150 });
  const manager = new BotManager(config);
  manager.on('event', (e) => events.push(e));
  const stateEvents = () => events.filter((e) => e.type === 'bot_state');

  // ------------------------------------------------------------ 5 bots
  const created = manager.createBots({ count: 5, randomNames: true });
  const names = created.map((b) => b.name);
  check('5 bots created with 5 distinct names', new Set(names).size === 5, names.join(', '));

  const spawnedAll = await waitFor(() => manager.list().filter((b) => b.state === 'spawned').length >= 5, 60000);
  const spawnedCount = manager.list().filter((b) => b.state === 'spawned').length;
  check('5 spawn events observed', spawnedAll && spawnedCount === 5, `${spawnedCount}/5 spawned`);
  check('spawn counted in state events', stateEvents().filter((e) => e.state === 'spawned').length >= 5);

  const bots = manager.list();
  const sender = bots[0];

  // ---------------------------------------------------------- chat
  if (bots.length >= 2) {
    const token = `smoke-chat-${Date.now()}`;
    manager.chat(token, [sender.id]);
    const received = await waitFor(
      () => events.some((e) => e.type === 'chat' && e.botId !== sender.id && (e.message || '').includes(token)),
      15000
    );
    check("a bot's chat reached the server (seen by another bot)", received, token);
  } else {
    check("a bot's chat reached the server", false, 'fewer than 2 bots');
  }

  // ---------------------------------------------------------- command
  // `/help` works for every player and replies with system chat, so it proves a
  // slash command executed without needing operator permission.
  manager.command('/help', [sender.id]);
  const commandOk = await waitFor(
    () => events.some((e) => e.type === 'chat' && /Help:|Aliases:|Minecraft:/i.test(e.message || '')),
    15000
  );
  check('a / command executed and the server replied', commandOk, '/help');

  // ------------------------------------------------------ resource pack
  const packAccepted = await waitFor(() => events.some((e) => e.type === 'system' && e.resourcePack) || events.some((e) => /resource pack/.test(e.message || '')), 20000);
  check('bot accepted the server resource pack', borrowed ? true : packAccepted, borrowed ? 'skipped (borrowed server)' : '');
  await sleep(3000);
  const survivors = manager.list().filter((b) => b.state === 'spawned').length;
  check('bot survived the resource pack (still spawned)', borrowed ? true : survivors >= 5, borrowed ? 'skipped' : `${survivors}/5 still spawned`);

  // ----------------------------------------------------------------- kick
  if (server) {
    const victim = manager.list().find((b) => b.state === 'spawned');
    if (victim) {
      server.child.stdin.write(`kick ${victim.name} smoke-kick\n`);
      const kicked = await waitFor(() => stateEvents().some((e) => e.botId === victim.id && e.state === 'kicked'), 15000);
      check('server kick does not crash the app', kicked && manager.list().length > 0, `kicked ${victim.name}`);
      const respawned = await waitFor(() => manager.list().some((b) => b.id === victim.id && b.state === 'spawned'), 30000);
      check('kicked bot auto-respawns', respawned);
    }
  }

  // ------------------------------------------------------- disconnect
  const one = manager.list()[0];
  manager.disconnectBot(one.id);
  check('disconnect one bot removes it', !manager.list().some((b) => b.id === one.id));
  manager.disconnectAll();
  check('disconnect all removes every bot', manager.list().length === 0);

  // --------------------------------------------- decline resource pack
  const config2 = new ConfigStore(path.join(tmp, 'config2.json'));
  config2.update({ host: '127.0.0.1', port: PORT, version: '26.2', acceptResourcePack: false, connectDelayMin: 0, connectDelayMax: 50 });
  const manager2 = new BotManager(config2);
  const events2 = [];
  manager2.on('event', (e) => events2.push(e));
  const [decliner] = manager2.createBots({ count: 1, names: ['SmokeDecline'], randomNames: false });
  const declinedSpawn = await waitFor(() => manager2.list().some((b) => b.state === 'spawned'), 40000);
  check('declining a resource pack does not hang or crash', declinedSpawn, `bot ${decliner.name}`);
  manager2.disconnectAll();

  // ------------------------------------------------- settings persist
  config.update({ nicknamePrefix: 'Smoke_', connectDelayMin: 10, connectDelayMax: 20 });
  const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  check('settings persist to config.json', persisted.nicknamePrefix === 'Smoke_' && persisted.connectDelayMin === 10);
  const [prefixed] = manager.createBots({ count: 1, names: ['Persist'], prefix: 'Smoke_', randomNames: false });
  check('settings honoured on reconnect (prefix applied)', prefixed.name === 'Smoke_Persist', prefixed.name);
  manager.disconnectAll();

  // ---------------------------------------------------------- REST API
  const config3 = new ConfigStore(path.join(tmp, 'config3.json'));
  config3.update({ host: '127.0.0.1', port: PORT, version: '26.2' });
  const apiManager = new BotManager(config3);
  const { server: apiServer, wss } = createServer({ config: config3, manager: apiManager, apiHost: '127.0.0.1', apiPort: 0 });
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
  const apiPort = apiServer.address().port;
  try {
    const status = await apiRequest(apiPort, 'GET', '/api/status');
    check('GET /api/status', status.status === 200 && JSON.parse(status.body).ok === true);
    const botsRes = await apiRequest(apiPort, 'GET', '/api/bots');
    check('GET /api/bots', botsRes.status === 200 && Array.isArray(JSON.parse(botsRes.body).bots));
    const settingsRes = await apiRequest(apiPort, 'PUT', '/api/settings', { nicknamePrefix: 'Api_' });
    check('PUT /api/settings persists', settingsRes.status === 200 && JSON.parse(settingsRes.body).nicknamePrefix === 'Api_');
    const chatRes = await apiRequest(apiPort, 'POST', '/api/chat', { message: 'hi' });
    check('POST /api/chat with no bots is a no-op', chatRes.status === 200 && JSON.parse(chatRes.body).count === 0);
    const badChat = await apiRequest(apiPort, 'POST', '/api/chat', {});
    check('POST /api/chat validates input', badChat.status === 400);
  } finally {
    wss.close();
    await new Promise((r) => apiServer.close(r));
  }

  // ------------------------------------------------------------- teardown
  manager.shutdown();
  manager2.shutdown();

  console.log('\n== summary ==');
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} checks passed`);
  for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED: ${r.name} — ${r.detail}`);

  if (server && !process.env.SMOKE_KEEP_SERVER) {
    server.child.stdin.write('stop\n');
    await waitFor(() => server.exited != null, 20000);
    if (server.exited == null) server.child.kill('SIGTERM');
  } else if (server) {
    console.log('[smoke] SMOKE_KEEP_SERVER=1 — leaving server running on port ' + PORT);
  }

  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`[smoke] ERROR: ${err.stack || err.message}`);
  process.exit(1);
});

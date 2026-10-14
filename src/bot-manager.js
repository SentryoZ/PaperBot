'use strict';

const { EventEmitter } = require('events');
const mineflayer = require('mineflayer');
const { generateNames } = require('./names');

let seq = 0;
function nextId() {
  seq += 1;
  return `bot-${Date.now().toString(36)}-${seq}`;
}

/**
 * BotManager owns the mineflayer client instances and exposes a small,
 * JSON-friendly control surface used by the REST/WS layer.
 *
 * Emits: 'event' with payloads shaped { type, ... } where type is one of
 * chat | system | bot_state | log.
 */
class BotManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    /** @type {Map<string, object>} */
    this.bots = new Map();
  }

  emitEvent(evt) {
    this.emit('event', { ts: Date.now(), ...evt });
    return evt;
  }

  log(level, message, meta = {}) {
    return this.emitEvent({ type: 'log', level, message, ...meta });
  }

  /** Serialize a single bot for API responses (no live client object). */
  serialize(entry) {
    return {
      id: entry.id,
      name: entry.name,
      state: entry.state,
      error: entry.error,
      responses: entry.responses,
      spawnCount: entry.spawnCount,
      createdAt: entry.createdAt,
      connectedAt: entry.connectedAt,
      lastErrorAt: entry.lastErrorAt,
      recentChat: entry.chatLog.slice(-20),
    };
  }

  list() {
    return [...this.bots.values()].map((b) => this.serialize(b));
  }

  get(id) {
    const entry = this.bots.get(id);
    return entry ? this.serialize(entry) : null;
  }

  /**
   * Create and connect `count` bots.
   * @param {{count?: number, names?: string[], prefix?: string, randomNames?: boolean}} opts
   */
  createBots(opts = {}) {
    const count = Math.max(0, Math.min(50, Number(opts.count) || 0));
    const settings = this.config.get();
    let names = Array.isArray(opts.names) ? opts.names.map(String).filter(Boolean) : [];
    const prefix = typeof opts.prefix === 'string' && opts.prefix.length ? opts.prefix : null;

    if (opts.randomNames !== false && names.length < count) {
      const taken = [...this.bots.values()].map((b) => b.name).concat(names);
      names = names.concat(generateNames(count - names.length, taken));
    }

    const created = [];
    for (let i = 0; i < count; i += 1) {
      let name = names[i];
      if (!name) {
        name = generateNames(1, [...this.bots.values()].map((b) => b.name))[0];
      }
      if (prefix) name = `${prefix}${name}`;
      if (name.length > 16) name = name.slice(0, 16);
      const entry = this._createEntry(name);
      created.push(this.serialize(entry));
    }

    // Stagger connections across the configured delay window so the server is
    // not hit with a burst of simultaneous logins.
    const { connectDelayMin, connectDelayMax } = settings;
    const lo = Number(connectDelayMin) || 0;
    const hi = Math.max(lo, Number(connectDelayMax) || 0);
    created.forEach((snapshot, idx) => {
      const entry = this.bots.get(snapshot.id);
      const delay = idx === 0 ? 0 : lo + Math.random() * (hi - lo);
      entry.timer = setTimeout(() => this._connectEntry(entry), Math.round(delay));
    });

    return created;
  }

  _createEntry(name) {
    const entry = {
      id: nextId(),
      name,
      state: 'pending',
      error: null,
      responses: [], // unmatched chat/whisper responses, kept small
      chatLog: [],
      spawnCount: 0,
      createdAt: Date.now(),
      connectedAt: null,
      lastErrorAt: null,
      bot: null,
      timer: null,
      autoRespawn: true,
      removed: false,
      reconnectTimer: null,
    };
    this.bots.set(entry.id, entry);
    this.emitEvent({ type: 'bot_state', botId: entry.id, name: entry.name, state: entry.state, error: null });
    return entry;
  }

  _setState(entry, state, error = null) {
    entry.state = state;
    if (error) {
      entry.error = String(error.message || error);
      entry.lastErrorAt = Date.now();
    } else if (state === 'spawned' || state === 'connecting') {
      entry.error = null;
    }
    this.emitEvent({
      type: 'bot_state',
      botId: entry.id,
      name: entry.name,
      state: entry.state,
      error: entry.error,
      errorDetail: error ? String(error.stack || error) : null,
    });
  }

  _connectEntry(entry) {
    if (entry.removed) return;
    const settings = this.config.get();
    this._setState(entry, 'connecting');
    this.log('info', `connecting ${entry.name} -> ${settings.host}:${settings.port} (${settings.version})`, {
      botId: entry.id,
      name: entry.name,
    });

    let bot;
    try {
      bot = mineflayer.createBot({
        host: settings.host,
        port: Number(settings.port),
        username: entry.name,
        version: settings.version,
        auth: 'offline',
      });
    } catch (err) {
      this._setState(entry, 'error', err);
      this.log('error', `failed to create bot ${entry.name}: ${err.message}`, { botId: entry.id });
      return;
    }
    entry.bot = bot;

    bot.once('login', () => {
      entry.connectedAt = Date.now();
      this._setState(entry, 'connected');
    });

    bot.once('spawn', () => {
      entry.spawnCount += 1;
      this._setState(entry, 'spawned');
      this.emitEvent({ type: 'system', botId: entry.id, name: entry.name, message: 'spawned' });
    });

    bot.on('message', (jsonMsg, position) => {
      const pos = position || 'chat';
      // Action-bar text is delivered as 'game_info' (position id 2, which
      // mineflayer also emits as 'actionBar'). It is transient HUD text rather
      // than chat, so don't log it or surface it in the web chat feed.
      if (pos === 'game_info') return;
      const text = jsonMsg && typeof jsonMsg.toString === 'function' ? jsonMsg.toString() : String(jsonMsg);
      const record = { ts: Date.now(), position: pos, text };
      entry.chatLog.push(record);
      if (entry.chatLog.length > 200) entry.chatLog.shift();
      entry.responses.push(record);
      if (entry.responses.length > 50) entry.responses.shift();
      this.emitEvent({ type: 'chat', botId: entry.id, name: entry.name, position: pos, message: text });
    });

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this._setState(entry, 'kicked', new Error(text));
      this.log('warn', `${entry.name} was kicked: ${text}`, { botId: entry.id });
    });

    bot.on('error', (err) => {
      this._setState(entry, 'error', err);
      this.log('error', `${entry.name} error: ${err.message}`, { botId: entry.id });
    });

    bot.on('end', (reason) => {
      this._setState(entry, 'disconnected', reason ? new Error(String(reason)) : null);
      this.log('info', `${entry.name} disconnected${reason ? `: ${reason}` : ''}`, { botId: entry.id });
      if (!entry.removed && entry.autoRespawn) {
        const delay = 2000;
        entry.reconnectTimer = setTimeout(() => {
          if (!entry.removed) this._connectEntry(entry);
        }, delay);
      }
    });

    this._wireResourcePack(entry, bot);
  }

  /**
   * Accept or decline server resource packs based on settings. Declining must
   * never hang or crash the connection.
   *
   * Note: during the configuration phase minecraft-protocol must answer the
   * pack or the server never sends finish_configuration, so mineflayer answers
   * automatically; we only observe and log that case.
   */
  _wireResourcePack(entry, bot) {
    const handle = (pack) => {
      const accept = this.config.get().acceptResourcePack !== false;
      const url = typeof pack === 'string' ? pack : (pack && (pack.url || pack.packUrl)) || 'unknown';

      if (bot._client && bot._client.state === 'configuration') {
        const mode = accept ? 'accepted' : 'auto-accepted by protocol layer';
        this.log('info', `${entry.name} resource pack during configuration (${mode}): ${url}`, { botId: entry.id, resourcePack: true });
        this.emitEvent({ type: 'system', botId: entry.id, name: entry.name, message: `resource pack during configuration: ${mode} (${url})`, resourcePack: true, accepted: accept });
        return;
      }

      try {
        if (accept) {
          bot.acceptResourcePack();
          this.log('info', `${entry.name} accepted resource pack (${url})`, { botId: entry.id, resourcePack: true });
          this.emitEvent({ type: 'system', botId: entry.id, name: entry.name, message: `accepted resource pack ${url}`, resourcePack: true, accepted: true });
        } else {
          bot.denyResourcePack();
          this.log('info', `${entry.name} declined resource pack (${url})`, { botId: entry.id, resourcePack: true });
          this.emitEvent({ type: 'system', botId: entry.id, name: entry.name, message: `declined resource pack ${url}`, resourcePack: true, accepted: false });
        }
      } catch (err) {
        // Never let a resource-pack failure kill the bot.
        this.log('warn', `${entry.name} resource pack handling failed: ${err.message}`, { botId: entry.id });
      }
    };

    if (bot._client && typeof bot._client.on === 'function') {
      bot._client.on('resource_pack_send', handle);
    }
    // mineflayer emits `resourcePack` for the 26.2 add_resource_pack packet too.
    bot.on('resourcePack', handle);
  }

  _resolveTargets(botIds) {
    const entries = [...this.bots.values()];
    if (!botIds || !botIds.length) return entries.filter((e) => e.bot);
    const wanted = new Set(botIds);
    return entries.filter((e) => wanted.has(e.id) && e.bot);
  }

  /** Chat as all/selected bots. */
  chat(message, botIds) {
    const text = String(message == null ? '' : message);
    const targets = this._resolveTargets(botIds);
    const delivered = [];
    for (const entry of targets) {
      try {
        entry.bot.chat(text);
        delivered.push(entry.id);
      } catch (err) {
        this.log('error', `${entry.name} chat failed: ${err.message}`, { botId: entry.id });
      }
    }
    return { delivered, count: delivered.length };
  }

  /** Run a slash command as all/selected bots. */
  command(command, botIds) {
    let text = String(command == null ? '' : command).trim();
    if (!text.startsWith('/')) text = `/${text}`;
    return this.chat(text, botIds);
  }

  disconnectBot(id) {
    const entry = this.bots.get(id);
    if (!entry) return null;
    entry.removed = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.bot) {
      try {
        entry.bot.quit('disconnected by user');
      } catch (err) {
        this.log('warn', `quit failed for ${entry.name}: ${err.message}`, { botId: id });
      }
    }
    this._setState(entry, 'disconnected');
    this.bots.delete(id);
    return this.serialize(entry);
  }

  disconnectAll() {
    const ids = [...this.bots.keys()];
    const removed = ids.map((id) => this.disconnectBot(id)).filter(Boolean);
    return { removed: removed.map((b) => b.id), count: removed.length };
  }

  shutdown() {
    for (const entry of this.bots.values()) {
      entry.removed = true;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      try {
        if (entry.bot) entry.bot.quit('shutdown');
      } catch (_) {
        /* ignore */
      }
    }
    this.bots.clear();
  }
}

module.exports = { BotManager, nextId };

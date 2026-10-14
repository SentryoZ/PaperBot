'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/** Default settings, also the shape returned by GET /api/settings. */
const DEFAULTS = {
  host: '127.0.0.1',
  port: 25565,
  version: process.env.MC_VERSION || '26.2',
  acceptResourcePack: true,
  nicknamePrefix: 'PaperBot',
  nicknameMode: 'random',
  connectDelayMin: 300,
  connectDelayMax: 1500,
};

/** Fields clients may set through PUT /api/settings. */
const SETTABLE = Object.keys(DEFAULTS);

class ConfigStore {
  constructor(file = CONFIG_PATH) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...DEFAULTS, ...sanitize(raw) };
      }
    } catch (err) {
      console.error(`[config] failed to read ${this.file}: ${err.message}; using defaults`);
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n');
    return this.data;
  }

  get() {
    return { ...this.data };
  }

  update(patch) {
    this.data = { ...this.data, ...sanitize(patch) };
    this.save();
    return this.get();
  }
}

function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of SETTABLE) {
    if (!(key in patch)) continue;
    const v = patch[key];
    switch (key) {
      case 'host':
      case 'version':
      case 'nicknamePrefix':
        if (typeof v === 'string' && v.length) out[key] = v;
        break;
      case 'nicknameMode':
        // random | realistic | custom list (plus legacy 'prefix')
        if (['random', 'realistic', 'custom', 'prefix'].includes(v)) out[key] = v;
        break;
      case 'acceptResourcePack':
        out[key] = Boolean(v);
        break;
      case 'port':
      case 'connectDelayMin':
      case 'connectDelayMax':
        if (Number.isFinite(Number(v))) out[key] = Number(v);
        break;
      default:
        break;
    }
  }
  return out;
}

module.exports = { ConfigStore, DEFAULTS, SETTABLE };

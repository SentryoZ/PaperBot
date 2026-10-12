'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

/**
 * Build the HTTP + WebSocket API server.
 * @param {{config: import('./config').ConfigStore, manager: import('./bot-manager').BotManager, apiHost?: string, apiPort?: number}} deps
 */
function createServer({ config, manager, apiHost = '127.0.0.1', apiPort = 3000 }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const asyncRoute = (fn) => (req, res) => {
    try {
      const result = fn(req, res);
      if (result && typeof result.then === 'function') {
        result.catch((err) => res.status(500).json({ error: err.message }));
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  app.get('/api/status', asyncRoute((req, res) => {
    const bots = manager.list();
    res.json({
      ok: true,
      version: config.get().version,
      settings: config.get(),
      api: { host: apiHost, port: apiPort },
      counts: {
        total: bots.length,
        spawned: bots.filter((b) => b.state === 'spawned').length,
        connected: bots.filter((b) => b.state === 'connected' || b.state === 'spawned').length,
        errored: bots.filter((b) => b.state === 'error' || b.state === 'kicked').length,
      },
      uptime: process.uptime(),
    });
  }));

  app.get('/api/settings', asyncRoute((req, res) => {
    res.json(config.get());
  }));

  app.put('/api/settings', asyncRoute((req, res) => {
    const updated = config.update(req.body || {});
    manager.log('info', 'settings updated');
    res.json(updated);
  }));

  app.get('/api/bots', asyncRoute((req, res) => {
    res.json({ bots: manager.list() });
  }));

  app.post('/api/bots', asyncRoute((req, res) => {
    const body = req.body || {};
    const created = manager.createBots({
      count: body.count,
      names: body.names,
      prefix: body.prefix,
      randomNames: body.randomNames,
    });
    if (!created.length) return res.status(400).json({ error: 'count must be >= 1' });
    res.status(201).json({ created, bots: manager.list() });
  }));

  app.delete('/api/bots/:id', asyncRoute((req, res) => {
    const removed = manager.disconnectBot(req.params.id);
    if (!removed) return res.status(404).json({ error: 'bot not found' });
    res.json({ removed, bots: manager.list() });
  }));

  app.post('/api/bots/disconnect-all', asyncRoute((req, res) => {
    const result = manager.disconnectAll();
    res.json({ ...result, bots: manager.list() });
  }));

  app.post('/api/chat', asyncRoute((req, res) => {
    const body = req.body || {};
    if (typeof body.message !== 'string' || !body.message.length) {
      return res.status(400).json({ error: 'message is required' });
    }
    const result = manager.chat(body.message, body.botIds);
    res.json(result);
  }));

  app.post('/api/command', asyncRoute((req, res) => {
    const body = req.body || {};
    if (typeof body.command !== 'string' || !body.command.length) {
      return res.status(400).json({ error: 'command is required' });
    }
    const result = manager.command(body.command, body.botIds);
    res.json(result);
  }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (payload) => {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try {
          client.send(data);
        } catch (_) {
          /* ignore */
        }
      }
    }
  };

  wss.on('connection', (socket) => {
    try {
      socket.send(JSON.stringify({ type: 'status', ...{ settings: config.get(), bots: manager.list() } }));
    } catch (_) {
      /* ignore */
    }
  });

  manager.on('event', broadcast);

  return { app, server, wss, broadcast };
}

module.exports = { createServer };

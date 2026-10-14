'use strict';

const { ConfigStore } = require('./config');
const { BotManager } = require('./bot-manager');
const { createServer } = require('./server');

const apiHost = process.env.API_HOST || '127.0.0.1';
const apiPort = Number(process.env.API_PORT || process.env.PORT || 25110);

function main() {
  const config = new ConfigStore();
  const manager = new BotManager(config);
  const { server } = createServer({ config, manager, apiHost, apiPort });

  server.listen(apiPort, apiHost, () => {
    // eslint-disable-next-line no-console
    console.log(`paper-test-bots listening on http://${apiHost}:${apiPort}`);
    console.log(`  target server: ${config.get().host}:${config.get().port} (MC ${config.get().version})`);
  });

  const shutdown = () => {
    console.log('\nshutting down...');
    manager.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { main };

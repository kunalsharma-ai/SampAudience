import { createServer } from 'node:http';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createStore } from './db';
import { logError } from './http';
import { migrate } from './migrate';
import { startWorker } from './worker';

async function main() {
  const cfg = loadConfig();
  const db = createStore(cfg.databaseUrl);
  await db.client.connect();
  await migrate(db);
  const { app, supply } = buildApp(db, cfg);
  const stop = process.env.WORKER_INLINE === 'false' ? () => undefined : startWorker(db, cfg, supply, logError);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(cfg.port, process.env.HOST ?? '0.0.0.0', resolve));
  console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: `SampAudience listening on ${cfg.port}` }));
  const shutdown = async () => {
    stop();
    await new Promise((r) => server.close(r));
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });

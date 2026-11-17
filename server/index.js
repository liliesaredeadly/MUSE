import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const server = createApp({ dbPath: process.env.MUSE_DB_PATH, serveStatic: process.env.NODE_ENV !== 'development' });
server.on('error', (error) => {
  console.error(`MUSE could not start on 127.0.0.1:${port}: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`MUSE server listening at http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close((error) => { if (error) console.error(error.message); });
  server.closeIdleConnections();
});

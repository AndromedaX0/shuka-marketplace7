import { createApp } from './app.js';
import { openDatabase } from './database/connection.js';

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be an integer between 1 and 65535.');
}

const db = openDatabase();
const server = createApp(db).listen(port, '0.0.0.0', () => {
  console.log(`Shuka API listening on http://0.0.0.0:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
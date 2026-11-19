import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../server/src/database/connection.js';

const source = path.resolve(process.env.DATABASE_PATH ?? './data/shuka.sqlite');
if (!fs.existsSync(source)) {
  throw new Error(`Database file does not exist: ${source}`);
}

const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const destination = path.resolve(
  process.argv[2] ?? path.join('backups', `shuka-${timestamp}.sqlite`),
);
fs.mkdirSync(path.dirname(destination), { recursive: true });
const db = openDatabase(source);
try {
  await db.backup(destination);
  console.log(`SQLite backup completed: ${destination}`);
} finally {
  db.close();
}

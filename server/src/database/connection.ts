import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export type ShukaDatabase = Database.Database;

export function openDatabase(filename = process.env.DATABASE_PATH ?? './data/shuka.sqlite'): ShukaDatabase {
  const absolutePath = path.resolve(filename);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const db = new Database(absolutePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  const versionText = (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
  const [major, minor, patch] = versionText.split('.').map(Number);
  const isSupported = major > 3 || (major === 3 && minor >= 37);
  if (!isSupported) {
    db.close();
    throw new Error('Shuka requires SQLite 3.37.0 or newer for STRICT tables.');
  }
  return db;
}

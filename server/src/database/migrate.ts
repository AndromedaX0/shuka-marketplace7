import type { ShukaDatabase } from './connection.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export function runMigrations(db: ShukaDatabase, migrationsDir = path.join(dirname, 'migrations')): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ) STRICT;`);
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map(x => x.version));
  const files = fs.readdirSync(migrationsDir).filter(f => /^\d+_[a-z0-9_-]+\.sql$/i.test(f)).sort();
  const newlyApplied: string[] = [];

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(filename);
    });
    apply.immediate();
    newlyApplied.push(filename);
  }
  return newlyApplied;
}

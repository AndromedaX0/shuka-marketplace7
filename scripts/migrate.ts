import { openDatabase } from '../server/src/database/connection.js';
import { runMigrations } from '../server/src/database/migrate.js';

const db = openDatabase();
try {
  const applied = runMigrations(db);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is already up to date.');
} finally {
  db.close();
}

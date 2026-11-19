import { openDatabase } from '../server/src/database/connection.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  throw new Error('Provide the existing account email: npm run admin:grant -- admin@example.am');
}

const db = openDatabase();
try {
  const user = db.prepare(`SELECT id, is_active AS isActive FROM users WHERE email=?`)
    .get(email) as { id: string; isActive: number } | undefined;
  if (!user) throw new Error(`No account exists for ${email}; register it before granting admin access.`);
  if (!user.isActive) throw new Error(`The account ${email} is suspended and cannot be granted admin access.`);
  db.prepare('INSERT INTO admins (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING').run(user.id);
  console.log(`Administrator access is enabled for ${email}.`);
} finally {
  db.close();
}

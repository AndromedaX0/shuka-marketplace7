ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
CREATE INDEX users_active_role_idx ON users(is_active, role);

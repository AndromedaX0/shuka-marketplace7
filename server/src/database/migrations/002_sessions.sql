-- Infrastructure table for persistent server-side sessions; not a core marketplace entity.
CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expired_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_expired_at_idx ON sessions(expired_at);

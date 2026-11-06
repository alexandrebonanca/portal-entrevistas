-- Avisos no portal ao titular da entrevista (a entidade promotora): o que o entrevistado fez e como corre a produção.
CREATE TABLE IF NOT EXISTS notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interview_id uuid REFERENCES interviews(id) ON DELETE CASCADE,
  kind text NOT NULL,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'ok', 'warn', 'bad')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  url text,
  dedupe_key text UNIQUE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notices_user ON notices (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notices_unread ON notices (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notices_interview ON notices (interview_id, created_at DESC);

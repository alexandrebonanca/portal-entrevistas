-- Convites para assistir a um episódio publicado: link pessoal (só o hash do código fica guardado), enviado pelo portal por
-- email ou partilhado pelo próprio entrevistador no WhatsApp. Vale também para episódios privados; revogável.
CREATE TABLE watch_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient_name text NOT NULL DEFAULT '',
  recipient_email text,
  views integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_invites_episode ON watch_invites (episode_id, created_at);

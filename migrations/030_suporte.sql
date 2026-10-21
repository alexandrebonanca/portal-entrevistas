-- Suporte interno (in-mail, sem email): pedidos de um utilizador (user_id) ou do convidado de uma entrevista (interview_id).
-- Apagar o utilizador ou a entrevista apaga os pedidos e as mensagens.
CREATE TABLE support_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  interview_id uuid REFERENCES interviews(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  origin text NOT NULL DEFAULT 'portal',
  lang text NOT NULL DEFAULT 'pt-PT',
  unread_user boolean NOT NULL DEFAULT false,
  unread_admin boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT support_threads_owner CHECK ((user_id IS NULL) <> (interview_id IS NULL)),
  CONSTRAINT support_threads_status CHECK (status IN ('open', 'answered', 'closed')),
  CONSTRAINT support_threads_origin CHECK (origin IN ('portal', 'guest', 'assistant')),
  CONSTRAINT support_threads_subject CHECK (char_length(subject) BETWEEN 1 AND 140)
);
CREATE INDEX support_threads_user ON support_threads(user_id, updated_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX support_threads_interview ON support_threads(interview_id, updated_at DESC) WHERE interview_id IS NOT NULL;
CREATE INDEX support_threads_inbox ON support_threads(status, updated_at DESC);
-- Contadores de por ler (navegação): só as linhas marcadas.
CREATE INDEX support_threads_unread_admin ON support_threads(updated_at) WHERE unread_admin;
CREATE INDEX support_threads_unread_user ON support_threads(user_id) WHERE unread_user AND user_id IS NOT NULL;
CREATE INDEX support_threads_unread_guest ON support_threads(interview_id) WHERE unread_user AND interview_id IS NOT NULL;

-- Mensagens de cada pedido: do utilizador, do convidado, do administrador (author_user_id) ou do assistente virtual.
CREATE TABLE support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  author text NOT NULL,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_author CHECK (author IN ('user', 'guest', 'admin', 'assistant')),
  CONSTRAINT support_messages_body CHECK (char_length(body) BETWEEN 1 AND 5000)
);
CREATE INDEX support_messages_thread ON support_messages(thread_id, created_at);

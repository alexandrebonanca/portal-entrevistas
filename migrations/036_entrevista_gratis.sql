-- 1.ª entrevista grátis (oferta do quietinterview a quem se regista: entrevistador sem entidade e sem subscrição) e
-- confirmação do email da conta, exigida só para essa oferta.
-- Email da conta confirmado pelo link do email «Confirm your email» (NULL = por confirmar).
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
-- Contas que já existem: ficam confirmadas as que não vieram do registo público (criadas pelo administrador, a primeira,
-- administradora) e as de uma entidade; as do registo público sem entidade ficam por confirmar e pedem o link no painel
-- («Reenviar»). Nunca provaram o email, e só a entrevista grátis o exige.
UPDATE users SET email_verified_at = created_at WHERE NOT self_signup OR entity_id IS NOT NULL;
-- Entrevista grátis usada pela conta (uma por conta): quando foi enviada e qual (a data fica mesmo que a entrevista seja apagada).
ALTER TABLE users ADD COLUMN free_interview_at timestamptz;
ALTER TABLE users ADD COLUMN free_interview_id uuid REFERENCES interviews(id) ON DELETE SET NULL;
-- Impressão (sha256) do email da conta normalizado (como o do convidado: sem o sub-endereço «+…» e, no Gmail, sem pontos), no
-- envio: uma entrevista grátis por caixa de correio, mesmo com várias contas (eve+1@gmail.com, e.v.e@gmail.com). Fica com a
-- data (a entrevista pode ser apagada); o índice único impede a segunda.
ALTER TABLE users ADD COLUMN free_owner_hash text;
ALTER TABLE users ADD CONSTRAINT users_free_owner CHECK ((free_interview_at IS NULL) = (free_owner_hash IS NULL) AND (free_owner_hash IS NULL OR free_owner_hash ~ '^[0-9a-f]{64}$'));
CREATE UNIQUE INDEX users_free_owner_hash ON users(free_owner_hash) WHERE free_owner_hash IS NOT NULL;
-- Entrevista enviada como grátis: quando, e a impressão (sha256) do email do convidado normalizado (uma entrevista grátis por
-- convidado em todo o portal; o índice único impede a segunda, mesmo vinda de outra conta).
ALTER TABLE interviews ADD COLUMN free_at timestamptz;
ALTER TABLE interviews ADD COLUMN free_guest_hash text;
ALTER TABLE interviews ADD CONSTRAINT interviews_free_guest CHECK ((free_at IS NULL) = (free_guest_hash IS NULL) AND (free_guest_hash IS NULL OR free_guest_hash ~ '^[0-9a-f]{64}$'));
CREATE UNIQUE INDEX interviews_free_guest_hash ON interviews(free_guest_hash) WHERE free_guest_hash IS NOT NULL;
-- Tetos diário e mensal (contados pela data do envio).
CREATE INDEX interviews_free_at ON interviews(free_at) WHERE free_at IS NOT NULL;
-- Links de confirmação do email: na base fica só a impressão (sha256) do token; valem 48 h e uma só vez. Com cada link, a
-- impressão (sha256) da caixa de correio do email da conta (normalizado como o do convidado): os emails de confirmação
-- contam-se por conta e por caixa de correio (várias contas com variantes do mesmo endereço não os multiplicam).
CREATE TABLE email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  mailbox_hash text NOT NULL CHECK (mailbox_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX email_verifications_user ON email_verifications(user_id, created_at);
CREATE INDEX email_verifications_mailbox ON email_verifications(mailbox_hash, created_at);
-- Ações de IA opcionais e sem custo para o utilizador, pedidas numa entrevista grátis (verificação do guião, leitura das
-- perguntas): quantas já foram usadas, contra o total por entrevista (free-interview.ts). Uma linha por entrevista e ação.
CREATE TABLE ai_uses (
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('script_review', 'question_reading')),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (interview_id, action)
)

-- Animação por orçamento: tarifas, orçamentos firmes por episódio e cobranças por fala (1 crédito = 1 € sem IVA).
-- Tarifas por motor: créditos por minuto de fala (em cêntimos), custo faturado pela Google por segundo de clipe e câmbio
-- conservador (€ por 1 $). Editáveis pelo administrador; cada alteração muda a versão e só vale para orçamentos novos.
CREATE TABLE animation_rates (
  id text PRIMARY KEY,
  engine text NOT NULL,
  tier text,
  label text NOT NULL,
  cents_per_min integer NOT NULL CHECK (cents_per_min > 0),
  cost_usd_per_sec double precision NOT NULL CHECK (cost_usd_per_sec > 0),
  usd_eur double precision NOT NULL CHECK (usd_eur > 0),
  -- Duração máxima de um clipe do motor: é o que se reserva no teto antes de cada envio.
  max_clip_sec integer NOT NULL CHECK (max_clip_sec > 0),
  resolution text NOT NULL DEFAULT '720p',
  -- Só os motores integrados e medidos se podem ativar (o Omni fica inativo até o Laboratório o medir).
  available boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  -- Data de desativação do modelo: a validade de um orçamento nunca passa daqui.
  valid_until timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (available OR NOT active)
);
-- Valores iniciais: Fast 30 cr/min (0,10 $/s) e Lite 15 cr/min (0,05 $/s), por confirmar na faturação Cloud do projeto.
INSERT INTO animation_rates(id, engine, tier, label, cents_per_min, cost_usd_per_sec, usd_eur, max_clip_sec, available, active) VALUES
  ('veo-fast', 'veo', 'fast', 'Google Veo 3.1 Fast', 3000, 0.10, 0.95, 8, true, true),
  ('veo-lite', 'veo', 'lite', 'Google Veo 3.1 Lite', 1500, 0.05, 0.95, 8, true, true),
  ('omni-flash', 'omni', NULL, 'Gemini Omni Flash', 3000, 0.101, 0.95, 10, false, false);
-- Orçamento firme de uma produção animada: as falas escolhidas (segundos, créditos, chave de reaproveitamento, take e
-- as chaves dos pedaços congeladas), o retrato da tarifa, o teto interno e, no fim, a liquidação por fala.
CREATE TABLE animation_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  script_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  entity_id uuid REFERENCES entities(id),
  wallet_id uuid REFERENCES wallets(id),
  created_by text NOT NULL,
  rate_id text NOT NULL REFERENCES animation_rates(id),
  rate jsonb NOT NULL,
  engine text NOT NULL,
  model text NOT NULL,
  tier text,
  lang text,
  selection jsonb NOT NULL,
  inputs_hash text NOT NULL,
  speech_sec integer NOT NULL CHECK (speech_sec >= 0),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  cap_usd double precision NOT NULL CHECK (cap_usd >= 0),
  est_minutes integer,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted', 'running', 'settled', 'void', 'cancelled')),
  status_note text,
  void_reason text,
  valid_until timestamptz NOT NULL,
  accepted_by text,
  accepted_at timestamptz,
  accepted_ip text,
  terms_version text,
  acceptance jsonb,
  job_id uuid,
  started_at timestamptz,
  charged_cents integer,
  released_cents integer,
  spent_usd double precision,
  settlement jsonb,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Um só orçamento aceite ou em curso por episódio.
CREATE UNIQUE INDEX animation_quotes_open ON animation_quotes (episode_id) WHERE status IN ('accepted', 'running');
CREATE INDEX animation_quotes_interview ON animation_quotes (interview_id, created_at);
-- Falas cobradas: uma fala igual (mesma fotografia original, texto, voz, papel e formato) cobra-se uma vez por take.
-- Guarda os clipes aprovados de cada pedaço, para o reaproveitamento a 0 créditos sem os voltar a julgar.
CREATE TABLE animation_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  reuse_key text NOT NULL,
  take integer NOT NULL DEFAULT 1 CHECK (take >= 1),
  quote_id uuid NOT NULL REFERENCES animation_quotes(id),
  segment_id text NOT NULL,
  role text NOT NULL,
  cents integer NOT NULL CHECK (cents >= 0),
  chunks jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_id, reuse_key, take)
);
-- Operações do Veo: a intenção ('reserved', sem nome) grava-se antes de cada envio com a duração máxima do motor, e
-- conta no teto do orçamento; recusada antes de a Google a aceitar passa a 'void' (custo 0).
ALTER TABLE veo_ops ALTER COLUMN op_name DROP NOT NULL;
ALTER TABLE veo_ops ADD COLUMN quote_id uuid;
ALTER TABLE veo_ops ADD COLUMN segment_key text;
ALTER TABLE veo_ops ADD COLUMN cost_usd double precision;
UPDATE veo_ops SET cost_usd = duration_sec * COALESCE(usd_per_sec, 0.10) WHERE cost_usd IS NULL;
CREATE INDEX veo_ops_quote ON veo_ops (quote_id, segment_key);
ALTER TABLE usage_ledger ADD COLUMN quote_id uuid

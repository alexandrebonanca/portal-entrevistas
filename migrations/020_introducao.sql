-- Introdução animada do entrevistador pelo Google Veo (oferecida, fora do orçamento): uma frase genérica em inglês, sem
-- nomes, escolhida de uma lista fixa do código, gerada uma vez por entrevistador e reaproveitada nos vídeos com animação
-- de todas as entrevistas dele. Frase escolhida (id da lista; NULL = sem introdução).
ALTER TABLE users ADD COLUMN intro_phrase text;
-- Cada geração pedida (no máximo 3 por entrevistador e por mês, as do administrador não contam). A chave junta a
-- fotografia original, a frase, a voz, o nível do Veo e o formato: só se gera de novo quando um destes muda. A entrevista
-- é a do pedido (fotografia e autorizações). O custo é interno (estimativa, também no usage_ledger como veo_usd_intro).
CREATE TABLE host_intros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interview_id uuid REFERENCES interviews(id) ON DELETE SET NULL,
  intro_key text NOT NULL,
  phrase text NOT NULL,
  photo_sha text NOT NULL,
  voice text NOT NULL,
  tier text NOT NULL,
  vertical boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  counts boolean NOT NULL DEFAULT true,
  sent integer NOT NULL DEFAULT 0,
  billed_sec integer NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0,
  failed_usd double precision NOT NULL DEFAULT 0,
  asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  model text,
  fidelity jsonb NOT NULL DEFAULT '[]',
  error text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX host_intros_user ON host_intros (user_id, created_at);
CREATE INDEX host_intros_key ON host_intros (user_id, intro_key, status);
-- Uma só geração em curso por entrevistador e chave (dois cliques não pagam duas vezes).
CREATE UNIQUE INDEX host_intros_open ON host_intros (user_id, intro_key) WHERE status IN ('queued', 'running')

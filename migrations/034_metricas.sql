-- Métricas das campanhas, só com dados próprios (sem cookies, sem píxeis de terceiros, sem IP).
-- Visitas agregadas por dia (UTC), página e etiquetas da campanha: só um contador, nada que identifique quem visitou.
-- Sem utm_source, a origem é o site de onde veio a visita (referrer_host, sem www.), ou nada (visita direta).
CREATE TABLE campaign_visits (
  day date NOT NULL,
  path text NOT NULL,
  source text NOT NULL DEFAULT '',
  medium text NOT NULL DEFAULT '',
  campaign text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  term text NOT NULL DEFAULT '',
  referrer_host text NOT NULL DEFAULT '',
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, path, source, medium, campaign, content, term, referrer_host)
);
-- Campanha que trouxe a conta (copiada do link da campanha para o formulário de registo, sem cookies).
-- Só o registo pelo site as preenche: as contas criadas pelo administrador ficam sem elas.
ALTER TABLE users ADD COLUMN utm_source text;
ALTER TABLE users ADD COLUMN utm_medium text;
ALTER TABLE users ADD COLUMN utm_campaign text;
ALTER TABLE users ADD COLUMN utm_content text;
ALTER TABLE users ADD COLUMN utm_term text;
ALTER TABLE users ADD COLUMN signup_referrer_host text;
-- Conta criada pela própria pessoa em /registar (um registo, para as métricas). A primeira conta (administradora) não conta.
ALTER TABLE users ADD COLUMN self_signup boolean NOT NULL DEFAULT false;
-- Registos anteriores a esta versão: os que ficaram na auditoria como registo de um entrevistador.
UPDATE users u SET self_signup = true
 WHERE EXISTS (SELECT 1 FROM audit_events a WHERE a.action = 'signup' AND a.actor = u.email AND a.meta->>'role' = 'interviewer');
-- Custos das campanhas registados à mão pelo administrador (o valor pago à rede, em cêntimos de euro), por origem e campanha.
CREATE TABLE campaign_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_from date NOT NULL,
  period_to date NOT NULL,
  source text NOT NULL CHECK (source <> ''),
  campaign text NOT NULL DEFAULT '',
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CHECK (period_to >= period_from)
);
CREATE INDEX campaign_spend_period ON campaign_spend (period_from, period_to);
CREATE INDEX users_self_signup ON users (created_at) WHERE self_signup;
-- Dia (UTC) em que a contagem das visitas começou: os registos anteriores não têm visitas contadas e ficam fora da conversão.
CREATE TABLE campaign_tracking (started_on date NOT NULL);
INSERT INTO campaign_tracking(started_on) VALUES ((now() AT TIME ZONE 'UTC')::date)

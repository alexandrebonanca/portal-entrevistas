-- Planos só com imagens: Start (19 € + IVA, 3 entrevistas) e Pro (49 € + IVA, 10 entrevistas).
-- Os antigos deixam de ser vendidos; as subscrições que já os têm mantêm-se como estão até mudarem de plano.
INSERT INTO plans(id, name, price_cents, interviews_per_month, sort, max_answer_total_sec, max_questions) VALUES ('start', 'Start', 1900, 3, 10, 900, 15) ON CONFLICT (id) DO NOTHING;
INSERT INTO plans(id, name, price_cents, interviews_per_month, sort, max_answer_total_sec, max_questions) VALUES ('pro', 'Pro', 4900, 10, 11, 900, 15) ON CONFLICT (id) DO NOTHING;
UPDATE plans SET active=false WHERE id IN ('starter', 'studio');
-- Dados de faturação do cliente. O IVA decide-se com eles antes do Checkout (país, empresa ou consumidor, código postal).
CREATE TABLE billing_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('business', 'consumer')),
  name text NOT NULL,
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  address text NOT NULL,
  postal_code text NOT NULL,
  city text NOT NULL,
  -- NIF português (9 algarismos): obrigatório nas empresas portuguesas, opcional nos consumidores.
  nif text CHECK (nif IS NULL OR nif ~ '^[0-9]{9}$'),
  -- Número de IVA de uma empresa de outro país da UE, com o prefixo; verificado pela Stripe no VIES (objeto tax_id).
  vat_number text CHECK (vat_number IS NULL OR vat_number ~ '^[A-Z]{2}[0-9A-Z]{2,12}$'),
  vat_status text CHECK (vat_status IS NULL OR vat_status IN ('pending', 'verified', 'unverified', 'unavailable')),
  vat_verified_name text,
  vat_checked_at timestamptz,
  stripe_tax_id text,
  stripe_tax_customer text,
  -- Prova do país do cliente: IP do último pedido de pagamento.
  last_checkout_ip text,
  last_checkout_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (country = 'PT' OR nif IS NULL),
  CHECK (country <> 'PT' OR vat_number IS NULL),
  CHECK (kind = 'business' OR vat_number IS NULL),
  CHECK (kind = 'consumer' OR country <> 'PT' OR nif IS NOT NULL)
);
CREATE INDEX billing_profiles_tax_id ON billing_profiles(stripe_tax_id);
-- Início do contrato pago (conta os 14 dias da livre resolução) e o IVA decidido na compra.
ALTER TABLE subscriptions ADD COLUMN contract_started_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN vat jsonb;
-- Lista «por faturar»: cada pagamento da Stripe espera a fatura-recibo emitida à mão no Moloni da empresa vendedora.
CREATE TABLE invoice_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'subscription',
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  stripe_ref text NOT NULL UNIQUE,
  stripe_number text,
  stripe_subscription_id text,
  stripe_customer_id text,
  plan_id text,
  reason text,
  description text NOT NULL,
  net_cents integer NOT NULL,
  vat_cents integer NOT NULL,
  total_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'eur',
  -- IVA decidido na compra: regime, taxa, país cujo IVA se aplica e a menção da fatura; o cliente (tipo e país).
  vat_rate numeric,
  vat_regime text,
  vat_country text,
  vat_note text,
  customer_kind text,
  customer_country text,
  customer jsonb NOT NULL DEFAULT '{}',
  -- Provas do país do cliente: morada de faturação, país do cartão, NIF ou número de IVA e verificação, IP.
  evidence jsonb NOT NULL DEFAULT '{}',
  -- Empresa vendedora no momento do pagamento (quem emite a fatura).
  seller jsonb NOT NULL DEFAULT '{}',
  terms_version text,
  paid_at timestamptz NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued')),
  moloni_doc text,
  issued_at timestamptz,
  issued_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR moloni_doc IS NOT NULL)
);
CREATE INDEX invoice_queue_status ON invoice_queue(status, paid_at);
-- Pedidos de livre resolução dos consumidores (botão na conta), tratados pelo administrador.
CREATE TABLE withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'subscription',
  stripe_ref text,
  plan_id text,
  contract_started_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  stripe_cancelled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'processed')),
  processed_at timestamptz,
  processed_by text,
  note text,
  UNIQUE (user_id, stripe_ref)
);

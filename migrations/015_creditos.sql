-- Créditos pré-pagos: 1 crédito = 1 € sem IVA, guardado em cêntimos. Vale de finalidade única: o IVA e a fatura-recibo
-- são do carregamento; o consumo não tem IVA nem fatura.
-- Carteira por (utilizador, entidade): os créditos pagos numa entidade só se gastam nos trabalhos que essa entidade corre.
CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  entity_id uuid REFERENCES entities(id),
  available_cents integer NOT NULL DEFAULT 0 CHECK (available_cents >= 0),
  -- Cativos (orçamentos aceites): saem do disponível na aceitação e liquidam-se no fim.
  reserved_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  -- Créditos já gastos que um reembolso fora da aplicação ou uma disputa tiraram; o carregamento seguinte paga-os primeiro.
  debt_cents integer NOT NULL DEFAULT 0 CHECK (debt_cents >= 0),
  -- Disputa (chargeback) em aberto: nada se gasta nem se reembolsa.
  frozen boolean NOT NULL DEFAULT false,
  currency text NOT NULL DEFAULT 'eur',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wallets_user_entity ON wallets (user_id, (COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid)));
-- Carregamentos, que são também os lotes de créditos (validade e consumo pela ordem de validade, FIFO).
-- O IVA decide-se no portal antes do Checkout e fica fixo no lote, com as provas do país do cliente.
CREATE TABLE credit_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  user_id uuid NOT NULL REFERENCES users(id),
  entity_id uuid REFERENCES entities(id),
  -- Conta Stripe que recebe o pagamento: a da entidade com Stripe própria (NULL = a global) e o retrato da chave usada.
  stripe_scope uuid REFERENCES entities(id),
  stripe_account text,
  net_cents integer NOT NULL CHECK (net_cents BETWEEN 2500 AND 100000 AND net_cents % 100 = 0),
  vat_cents integer NOT NULL CHECK (vat_cents >= 0),
  gross_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'eur',
  vat_rate numeric NOT NULL,
  vat_regime text NOT NULL,
  vat_country text,
  vat_note text,
  customer_kind text NOT NULL CHECK (customer_kind IN ('business', 'consumer')),
  customer_country text NOT NULL,
  -- Dados do cliente para a fatura, provas do país (morada, país do cartão, NIF ou número de IVA e verificação, IP) e a vendedora.
  customer jsonb NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '{}',
  seller jsonb NOT NULL DEFAULT '{}',
  terms_version text,
  return_path text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded', 'disputed')),
  stripe_session_id text UNIQUE,
  stripe_payment_intent text UNIQUE,
  stripe_charge text,
  stripe_customer_id text,
  -- Repartição do lote: disponível + usado (gasto, cativo ou a pagar dívida) + reembolsado + caducado + perdido em disputa = net_cents.
  remaining_cents integer NOT NULL DEFAULT 0 CHECK (remaining_cents >= 0),
  used_cents integer NOT NULL DEFAULT 0 CHECK (used_cents >= 0),
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  expired_cents integer NOT NULL DEFAULT 0 CHECK (expired_cents >= 0),
  disputed_cents integer NOT NULL DEFAULT 0 CHECK (disputed_cents >= 0),
  paid_at timestamptz,
  expires_at timestamptz,
  expiry_warned_at timestamptz,
  -- Fatura-recibo emitida à mão no Moloni (copiada da lista «por faturar»).
  moloni_doc text,
  -- Anomalia para o administrador (valor diferente, pagamento num carregamento já expirado, reembolso fora da aplicação…).
  alert text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_cents = net_cents + vat_cents),
  CHECK (remaining_cents + used_cents + refunded_cents + expired_cents + disputed_cents IN (0, net_cents)),
  CHECK (status IN ('pending', 'failed', 'expired') OR (paid_at IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX credit_topups_fifo ON credit_topups (wallet_id, expires_at) WHERE remaining_cents > 0;
CREATE INDEX credit_topups_charge ON credit_topups (stripe_charge);
CREATE INDEX credit_topups_user ON credit_topups (user_id, created_at);
-- Livro-razão imutável da carteira: cada movimento com as variações do disponível, do cativo e da dívida, e os lotes
-- de onde saíram (ou para onde voltaram) os créditos: [{"t": lote, "c": cêntimos, "b": parcela do lote}].
-- Invariante: a soma das variações de cada carteira é igual aos saldos dela.
CREATE TABLE wallet_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  kind text NOT NULL CHECK (kind IN ('topup', 'debit', 'reversal', 'reserve', 'capture', 'release', 'refund', 'refund_reversal', 'external_refund', 'external_refund_reversal', 'dispute', 'dispute_won', 'dispute_lost', 'expire')),
  available_delta integer NOT NULL DEFAULT 0,
  reserved_delta integer NOT NULL DEFAULT 0,
  debt_delta integer NOT NULL DEFAULT 0,
  lots jsonb NOT NULL DEFAULT '[]',
  topup_id uuid REFERENCES credit_topups(id),
  quote_id uuid,
  interview_id uuid,
  job_id uuid,
  stripe_ref text,
  ref text,
  note text,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, stripe_ref),
  UNIQUE (kind, ref)
);
CREATE INDEX wallet_entries_wallet ON wallet_entries (wallet_id, created_at);
CREATE FUNCTION wallet_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'wallet_entries é um livro-razão imutável'; END $$;
CREATE TRIGGER wallet_entries_immutable BEFORE UPDATE OR DELETE ON wallet_entries FOR EACH ROW EXECUTE FUNCTION wallet_entries_immutable();
-- Reembolsos de carregamentos: pedidos pela aplicação (saldo disponível nos 14 dias, ou encerramento do serviço) ou feitos
-- no painel da Stripe (identificados pelo payment_intent ou charge do carregamento, nunca pela metadata).
CREATE TABLE credit_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topup_id uuid NOT NULL REFERENCES credit_topups(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  source text NOT NULL CHECK (source IN ('app', 'stripe')),
  reason text NOT NULL CHECK (reason IN ('withdrawal', 'closure', 'stripe')),
  net_cents integer NOT NULL CHECK (net_cents > 0),
  gross_cents integer NOT NULL CHECK (gross_cents > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  stripe_refund_id text UNIQUE,
  error text,
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_refunds_topup ON credit_refunds (topup_id);
-- Cliente Stripe por (utilizador, conta Stripe): a entidade com Stripe própria, ou 'global'.
CREATE TABLE stripe_customers (
  user_id uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL,
  customer_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);
-- Entrevista convidada para além da quota do plano, paga com créditos (NULL = dentro do plano).
ALTER TABLE interviews ADD COLUMN extra_cents integer;
-- Os carregamentos e os reembolsos entram na lista «por faturar» (fatura-recibo e nota de crédito).
ALTER TABLE invoice_queue ADD COLUMN topup_id uuid REFERENCES credit_topups(id);

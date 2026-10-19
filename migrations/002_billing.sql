ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN stripe_customer_id text;
CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  price_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'eur',
  interviews_per_month integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0
);
INSERT INTO plans(id, name, price_cents, interviews_per_month, sort) VALUES ('starter', 'Starter', 1000, 5, 1), ('studio', 'Studio', 5000, 10, 2);
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_id text REFERENCES plans(id),
  status text NOT NULL DEFAULT 'inactive',
  source text NOT NULL DEFAULT 'stripe',
  stripe_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  interviews_override integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE settings (
  key text PRIMARY KEY,
  value_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

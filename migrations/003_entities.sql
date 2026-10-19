CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  url text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE entity_settings (
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  key text NOT NULL,
  value_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, key)
);
ALTER TABLE users ADD COLUMN entity_id uuid REFERENCES entities(id);
INSERT INTO entities(slug, name, url) VALUES ('telecert-formacao', 'Telecert Formação', 'https://www.grupotelecert.com');

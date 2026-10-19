CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'interviewer',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  objective_text text NOT NULL DEFAULT '',
  objective_shared boolean NOT NULL DEFAULT true,
  objective_asset_id uuid,
  host_name text NOT NULL DEFAULT '',
  host_photo_asset_id uuid,
  host_photo_rights boolean NOT NULL DEFAULT false,
  guest_name text NOT NULL DEFAULT '',
  guest_email text NOT NULL DEFAULT '',
  interaction_lang text NOT NULL DEFAULT 'pt-PT',
  answer_lang text NOT NULL DEFAULT 'auto',
  deadline date,
  personal_message text NOT NULL DEFAULT '',
  planned_visibility text NOT NULL DEFAULT 'private',
  subtitle_langs text[] NOT NULL DEFAULT ARRAY['en','pt-PT'],
  review_policy text NOT NULL DEFAULT 'guest_preview',
  version integer NOT NULL DEFAULT 1,
  collection_status text NOT NULL DEFAULT 'draft',
  production_status text NOT NULL DEFAULT 'not_requested',
  publication_status text NOT NULL DEFAULT 'private',
  invited_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid REFERENCES interviews(id) ON DELETE CASCADE,
  kind text NOT NULL,
  mime text NOT NULL,
  size bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  duration_ms integer,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  position integer NOT NULL,
  version integer NOT NULL DEFAULT 1,
  text text NOT NULL DEFAULT '',
  audio_asset_id uuid,
  tts_asset_id uuid,
  followup boolean NOT NULL DEFAULT false
);
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  question_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  declined_at timestamptz,
  first_opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guest_sessions (
  id text PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  granted boolean NOT NULL,
  text_version text NOT NULL,
  text_snapshot text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_lookup ON consents(interview_id, purpose, created_at DESC);
CREATE TABLE answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  status text NOT NULL,
  selected_take_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id)
);
CREATE TABLE answer_takes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_id uuid NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id),
  uploaded_via text NOT NULL DEFAULT 'recording',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id),
  use_on_cover boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  text text NOT NULL,
  language text,
  origin text NOT NULL DEFAULT 'machine',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id, revision)
);
CREATE TABLE scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  title_en text NOT NULL,
  segments jsonb NOT NULL,
  review_flags jsonb NOT NULL DEFAULT '[]',
  blocking_issues jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft',
  prompt_version text NOT NULL,
  model text NOT NULL,
  origin text NOT NULL DEFAULT 'machine',
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_id, revision)
);
CREATE TABLE episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  script_id uuid NOT NULL REFERENCES scripts(id),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  audio_asset_id uuid,
  cover_asset_id uuid,
  cover_thumb_asset_id uuid,
  duration_ms integer,
  subtitles jsonb NOT NULL DEFAULT '{}',
  chapters jsonb NOT NULL DEFAULT '[]',
  technical jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'preview',
  visibility text NOT NULL DEFAULT 'private',
  stale boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor text NOT NULL,
  script_id uuid,
  episode_id uuid,
  decision text NOT NULL,
  note text NOT NULL DEFAULT '',
  valid boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid REFERENCES interviews(id) ON DELETE CASCADE,
  kind text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  result jsonb,
  error text,
  progress_done integer NOT NULL DEFAULT 0,
  progress_total integer NOT NULL DEFAULT 0,
  cost_estimate_usd numeric(10,4),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX jobs_queue ON jobs(state, run_after);
CREATE TABLE emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  interview_id uuid,
  to_email text NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  text_body text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  provider_id text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  interview_id uuid,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid,
  kind text NOT NULL,
  quantity numeric NOT NULL,
  cost_usd numeric(10,4),
  estimated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

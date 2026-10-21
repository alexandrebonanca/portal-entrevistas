-- Assistente virtual da página de ajuda: base de conhecimento editável pelo administrador (perguntas e respostas).
-- seed_key identifica as entradas da semente inicial (src/assistant-faq.ts), inseridas no arranque só se ainda não existirem
-- (as alterações do administrador nunca são substituídas). As entradas criadas pelo administrador ficam com seed_key NULL.
CREATE TABLE assistant_faq (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_key text,
  lang text NOT NULL,
  audience text NOT NULL,
  question text NOT NULL,
  answer text NOT NULL,
  keywords text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_faq_seed UNIQUE (seed_key, lang),
  CONSTRAINT assistant_faq_lang CHECK (lang IN ('pt', 'en')),
  CONSTRAINT assistant_faq_audience CHECK (audience IN ('interviewer', 'guest', 'all')),
  CONSTRAINT assistant_faq_question CHECK (char_length(question) BETWEEN 1 AND 300),
  CONSTRAINT assistant_faq_answer CHECK (char_length(answer) BETWEEN 1 AND 4000),
  CONSTRAINT assistant_faq_keywords CHECK (char_length(keywords) <= 500)
);
CREATE INDEX assistant_faq_list ON assistant_faq(lang, audience, sort) WHERE active;

-- Registo das perguntas feitas ao assistente, para melhorar a base. Sem dados de quem perguntou (nem utilizador,
-- nem entrevista, nem IP): só o texto (com emails, números e links tapados), a língua, o público, as entradas usadas
-- e se ajudou. Apagado ao fim de 180 dias.
CREATE TABLE assistant_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lang text NOT NULL,
  audience text NOT NULL,
  question text NOT NULL,
  faq_ids uuid[] NOT NULL DEFAULT '{}',
  answered boolean NOT NULL,
  mode text NOT NULL DEFAULT 'local',
  answer text,
  helped boolean,
  escalated boolean NOT NULL DEFAULT false,
  reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_questions_lang CHECK (lang IN ('pt', 'en')),
  CONSTRAINT assistant_questions_audience CHECK (audience IN ('interviewer', 'guest')),
  CONSTRAINT assistant_questions_mode CHECK (mode IN ('local', 'ai')),
  CONSTRAINT assistant_questions_question CHECK (char_length(question) BETWEEN 1 AND 500),
  CONSTRAINT assistant_questions_answer CHECK (answer IS NULL OR char_length(answer) <= 4000)
);
CREATE INDEX assistant_questions_created ON assistant_questions(created_at);
-- Lista do administrador: perguntas sem resposta ou marcadas «não ajudou», ainda por tratar.
CREATE INDEX assistant_questions_review ON assistant_questions(created_at DESC) WHERE NOT reviewed AND (NOT answered OR helped = false);

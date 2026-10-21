-- Limites de cada entrevista nos planos: tempo total das respostas do convidado e número de perguntas (adicionais incluídas).
ALTER TABLE plans ADD COLUMN max_answer_total_sec integer NOT NULL DEFAULT 900 CHECK (max_answer_total_sec > 0);
ALTER TABLE plans ADD COLUMN max_questions integer NOT NULL DEFAULT 15 CHECK (max_questions > 0);
-- Copiados do plano no convite e fixos depois disso: mudar de plano não altera o que foi prometido ao convidado.
-- NULL = sem limite (convite feito pelo administrador, ou entrevistas convidadas antes desta versão).
ALTER TABLE interviews ADD COLUMN answer_limit_sec integer;
ALTER TABLE interviews ADD COLUMN question_limit integer;

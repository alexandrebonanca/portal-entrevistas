-- Vídeo editorial (ensaio HTA, 06/11/2026): o promotor da entrevista aparece no cartão de abertura e no final.
-- Vazio: usa o nome da entidade do entrevistador (ou só a marca do portal).
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS promoter_name text NOT NULL DEFAULT '';

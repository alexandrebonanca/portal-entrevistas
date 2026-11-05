-- Verificação das respostas antes da produção e pedido ao entrevistado para gravar de novo algumas respostas.
-- answers.redo_requested_at: o entrevistador pediu que esta resposta fosse gravada de novo (limpo quando chega uma nova).
ALTER TABLE answers ADD COLUMN IF NOT EXISTS redo_requested_at timestamptz;
-- Nota do último pedido (o que correu mal), mostrada ao entrevistado na entrevista e no email.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS redo_note text;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS answers_checked_at timestamptz;

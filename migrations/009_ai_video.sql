-- Autorização própria do entrevistador para o vídeo gerado pelo Google Veo (imagem e voz geradas pelo modelo).
ALTER TABLE interviews ADD COLUMN host_ai_video boolean NOT NULL DEFAULT false;

-- Operações do Veo já aceites (e cobradas) pela Google: uma nova tentativa retoma a consulta em vez de pagar outra vez.
CREATE TABLE veo_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  chunk_key text NOT NULL,
  op_name text NOT NULL,
  duration_sec int NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX veo_ops_chunk ON veo_ops(interview_id, chunk_key, state);

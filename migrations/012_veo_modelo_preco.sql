-- Modelo e preço por segundo de cada operação do Veo (Vertex AI ou Gemini API; Fast ou Lite): o custo de uma operação
-- retomada ou falhada na Google é corrigido com o preço com que foi submetida.
ALTER TABLE veo_ops ADD COLUMN model text;
ALTER TABLE veo_ops ADD COLUMN usd_per_sec double precision;
-- As operações anteriores foram todas do Veo 3.1 Fast na Gemini API (0,10 $/s).
UPDATE veo_ops SET model='veo-3.1-fast-generate-preview', usd_per_sec=0.10 WHERE model IS NULL;

-- Vídeo premium: animação de cada fala a partir da fotografia, com a voz do episódio (HeyGen Avatar IV), vendida por créditos.
-- Custo de produção por minuto de vídeo: 0,0385 $/s × 60 = 2,31 $ (animação) + ~0,04 $ (transcrição, tradução, vozes e
-- montagem) = ~2,35 $/min; ao câmbio conservador de 0,95 € por 1 $ ≈ 2,23 €/min; × 2 = 4,47 € → 4,5 créditos por minuto.
-- O Google Veo deixa de se vender (fica inativo; o código mantém-se para os orçamentos antigos).
INSERT INTO animation_rates(id, engine, tier, label, cents_per_min, cost_usd_per_sec, usd_eur, max_clip_sec, resolution, available, active)
  VALUES ('heygen', 'heygen', NULL, 'Vídeo premium', 450, 0.0385, 0.95, 600, '720p', true, true)
  ON CONFLICT (id) DO NOTHING;
UPDATE animation_rates SET active=false WHERE engine='veo';
-- Autorização do entrevistador para o vídeo premium: o texto passou a nomear o novo fornecedor (HeyGen); as autorizações
-- dadas com o texto antigo (Google Veo) não servem para ele. Guarda-se o fornecedor do texto que o entrevistador viu.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS host_ai_video_provider text;

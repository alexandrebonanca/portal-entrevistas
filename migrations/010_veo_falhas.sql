-- Causa da falha de cada operação do Veo.
ALTER TABLE veo_ops ADD COLUMN error text;

-- Até aqui, as falhas passageiras da Google («high demand») ficavam como 'failed' e gastavam o limite de tentativas
-- do pedaço; a estimativa de custo ficava como paga. Passam a 'busy' (não contam) e a estimativa vai para
-- 'veo_usd_failed' (operações sem vídeo, normalmente não cobradas pela Google).
INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated)
  SELECT interview_id, 'veo_usd', -duration_sec, -duration_sec * 0.10, true FROM veo_ops WHERE state='failed';
INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated)
  SELECT interview_id, 'veo_usd_failed', duration_sec, duration_sec * 0.10, true FROM veo_ops WHERE state='failed';
UPDATE veo_ops SET state='busy', error='(antes da migração 010)' WHERE state='failed';

-- Autorização própria do entrevistador para o vídeo gerado pelo Google Veo (imagem e voz geradas pelo modelo).
ALTER TABLE interviews ADD COLUMN host_ai_video boolean NOT NULL DEFAULT false;

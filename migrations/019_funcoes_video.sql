-- Função de cada pessoa no rodapé animado do vídeo (texto livre em inglês, como o episódio, ex.: «Chief engineer,
-- Lisbon»). Vazia: o rodapé mostra «Host» ou «Guest».
ALTER TABLE interviews ADD COLUMN host_title text NOT NULL DEFAULT '';
ALTER TABLE interviews ADD COLUMN guest_title text NOT NULL DEFAULT '';

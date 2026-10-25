-- Fotografia do convidado escolhida ou acrescentada pelo entrevistador, com a autorização de edição (consentimento
-- host_edit, pedido no convite): por exemplo, quando a Google recusa animar a fotografia que o convidado enviou.
-- Quem acrescentou a fotografia: 'guest' (o convidado, as três dele) ou 'host' (o entrevistador).
ALTER TABLE photos ADD COLUMN added_by text NOT NULL DEFAULT 'guest';
-- Fotografia do convidado usada no vídeo (NULL: a primeira da capa ou, sem capa, a mais antiga).
ALTER TABLE interviews ADD COLUMN guest_photo_id uuid REFERENCES photos(id) ON DELETE SET NULL;

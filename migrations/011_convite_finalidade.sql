-- Finalidade de cada link enviado ao convidado: convite, perguntas adicionais ou validação do episódio.
-- A validação tem email, página de abertura e destino próprios (sem «Não pretendo participar»).
ALTER TABLE invitations ADD COLUMN purpose text NOT NULL DEFAULT 'invite';

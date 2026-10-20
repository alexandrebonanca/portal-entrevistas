-- Finalidade de cada link enviado ao convidado: convite, perguntas adicionais ou validação do episódio.
-- A validação tem email, página de abertura e destino próprios (sem «Não pretendo participar»).
ALTER TABLE invitations ADD COLUMN purpose text NOT NULL DEFAULT 'invite';

-- Links de pré-visualização enviados antes desta versão (identificados pelo assunto do email) passam a validação.
UPDATE invitations SET purpose='preview'
 WHERE id::text IN (SELECT substring(dedupe_key from 8) FROM emails
                     WHERE dedupe_key LIKE 'invite:%' AND (subject LIKE 'Reveja o seu episódio%' OR subject LIKE 'Please review your episode%'));

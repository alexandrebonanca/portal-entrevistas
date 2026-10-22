-- Contacto de visitantes sem conta (formulário público /contact), na mesma caixa de entrada do administrador.
-- O visitante lê e responde por um link privado enviado por email. Na base fica só o hash (sha256) do token e o valor
-- aleatório de que o servidor o deriva com o APP_SECRET (para voltar a mandar o link a cada resposta); apagar o pedido
-- invalida o link. Os pedidos que já existem (de um utilizador ou do convidado de uma entrevista) não mudam.
ALTER TABLE support_threads ADD COLUMN visitor_name text;
ALTER TABLE support_threads ADD COLUMN visitor_email text;
ALTER TABLE support_threads ADD COLUMN visitor_token_hash text;
ALTER TABLE support_threads ADD COLUMN visitor_token_nonce text;
-- Tema escolhido no formulário e referência opcional a um episódio (o endereço /e/… ou o título, tal como escrito).
ALTER TABLE support_threads ADD COLUMN topic text;
ALTER TABLE support_threads ADD COLUMN episode_ref text;
-- Cada pedido é de exatamente um: um utilizador, o convidado de uma entrevista ou um visitante.
ALTER TABLE support_threads DROP CONSTRAINT support_threads_owner;
ALTER TABLE support_threads ADD CONSTRAINT support_threads_owner CHECK ((user_id IS NOT NULL)::int + (interview_id IS NOT NULL)::int + (visitor_email IS NOT NULL)::int = 1);
ALTER TABLE support_threads DROP CONSTRAINT support_threads_origin;
ALTER TABLE support_threads ADD CONSTRAINT support_threads_origin CHECK (origin IN ('portal', 'guest', 'assistant', 'visitor'));
-- Os dados do visitante vêm todos juntos, e só nos pedidos com origem «visitor».
ALTER TABLE support_threads ADD CONSTRAINT support_threads_visitor CHECK (
  (origin = 'visitor' AND visitor_name IS NOT NULL AND visitor_email IS NOT NULL AND visitor_token_hash IS NOT NULL AND visitor_token_nonce IS NOT NULL)
  OR (origin <> 'visitor' AND visitor_name IS NULL AND visitor_email IS NULL AND visitor_token_hash IS NULL AND visitor_token_nonce IS NULL));
ALTER TABLE support_threads ADD CONSTRAINT support_threads_visitor_name CHECK (char_length(visitor_name) BETWEEN 1 AND 100);
ALTER TABLE support_threads ADD CONSTRAINT support_threads_visitor_email CHECK (char_length(visitor_email) BETWEEN 3 AND 254);
ALTER TABLE support_threads ADD CONSTRAINT support_threads_visitor_token CHECK (visitor_token_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE support_threads ADD CONSTRAINT support_threads_topic CHECK (topic IN ('sales', 'interview', 'episode', 'privacy', 'other'));
ALTER TABLE support_threads ADD CONSTRAINT support_threads_episode_ref CHECK (char_length(episode_ref) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX support_threads_visitor_token ON support_threads(visitor_token_hash) WHERE visitor_token_hash IS NOT NULL;
-- Mensagens do visitante (pelo formulário e pelo link privado).
ALTER TABLE support_messages DROP CONSTRAINT support_messages_author;
ALTER TABLE support_messages ADD CONSTRAINT support_messages_author CHECK (author IN ('user', 'guest', 'admin', 'assistant', 'visitor'));

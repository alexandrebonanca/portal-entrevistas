-- Âmbito das credenciais com que cada operação do Veo foi criada ('global' ou o id da entidade) e o projeto Google da
-- conta de serviço (Vertex AI): uma operação pendente consulta-se sempre com essas credenciais, não com as que estiverem
-- em vigor. As anteriores ficam sem âmbito e consultam-se com as credenciais em vigor, como até aqui.
ALTER TABLE veo_ops ADD COLUMN cred_scope text;
ALTER TABLE veo_ops ADD COLUMN project text;

-- Versão de cada entrada da semente do assistente: seed_hash é a impressão do texto (público, pergunta, resposta e
-- palavras-chave) que a semente escreveu da última vez. No arranque, uma entrada cujo texto ainda é igual a essa versão
-- (o administrador não a alterou) passa ao texto atual da semente; as alterações do administrador ficam sempre.
-- NULL nas entradas semeadas antes desta migração: reconhecem-se pelas versões publicadas (src/assistant-faq-legacy.ts).
ALTER TABLE assistant_faq ADD COLUMN seed_hash text;

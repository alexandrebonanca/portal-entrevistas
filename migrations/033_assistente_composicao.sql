-- Assistente de composição da página de edição: pedidos à IA contados por dia, por pessoa (who = id da conta) e no
-- total do portal (who = 'global'), para os tetos diários e mensais resistirem a reinícios e novas publicações.
CREATE TABLE compose_usage (
  who text NOT NULL,
  day date NOT NULL,
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (who, day)
);

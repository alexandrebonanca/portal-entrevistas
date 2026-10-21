-- Fila com duas vias (curta e vídeos), batimento dos trabalhos em curso e vigilante próprio.
-- ready_at: momento em que o trabalho pôde arrancar (via livre e nada à frente); o prazo de 24 h dos orçamentos aceites
-- conta a partir daqui, não do tempo à espera dos vídeos à frente na fila.
ALTER TABLE jobs ADD COLUMN ready_at timestamptz;
-- interruptions: vezes que o processo que corria o trabalho morreu (reinício, deploy). Num trabalho de orçamento um
-- reinício não gasta tentativa (a retoma é idempotente); este contador trava um ciclo infinito de reinícios.
ALTER TABLE jobs ADD COLUMN interruptions integer NOT NULL DEFAULT 0;
CREATE INDEX jobs_running ON jobs(state, locked_at) WHERE state='running';

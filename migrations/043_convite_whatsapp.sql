-- Convite pelo WhatsApp: um segundo link pessoal, enviado pelo próprio entrevistador do telemóvel dele, ao lado do email.
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

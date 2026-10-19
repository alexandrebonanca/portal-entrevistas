ALTER TABLE emails ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
UPDATE emails SET state='pending', attempts=0, next_attempt_at=now(), error=NULL WHERE state='failed';

ALTER TABLE interviews ADD COLUMN guest_voice text NOT NULL DEFAULT 'female';
ALTER TABLE episodes ADD COLUMN video_asset_id uuid;
ALTER TABLE episodes ADD COLUMN video_lang text;
ALTER TABLE episodes ADD COLUMN gallery boolean NOT NULL DEFAULT false;
ALTER TABLE episodes ADD COLUMN theme text NOT NULL DEFAULT '';

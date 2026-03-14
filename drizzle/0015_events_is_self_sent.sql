-- Add is_self_sent column to events table.
-- Marks bot's own sent messages at creation time (not derived from sender ID).
ALTER TABLE `events` ADD COLUMN `is_self_sent` integer;

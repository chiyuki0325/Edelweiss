ALTER TABLE `events` ADD `is_myself` integer;--> statement-breakpoint

-- Existing instance-sent messages are necessarily from the platform account.
UPDATE `events`
SET `is_myself` = 1
WHERE `is_self_sent` = 1;

CREATE TABLE `message_reaction_states` (
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`counts` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_reaction_states_chat_message_idx` ON `message_reaction_states` (`chat_id`,`message_id`);--> statement-breakpoint
ALTER TABLE `events` ADD `reaction_data` text;
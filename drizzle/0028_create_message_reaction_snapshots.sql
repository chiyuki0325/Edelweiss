CREATE TABLE `message_reaction_snapshots` (
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`reactions` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_reaction_snapshots_chat_message_idx` ON `message_reaction_snapshots` (`chat_id`,`message_id`);--> statement-breakpoint
DROP TABLE `message_reaction_states`;
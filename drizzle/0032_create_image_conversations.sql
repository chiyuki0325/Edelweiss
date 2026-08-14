CREATE TABLE `image_conversation_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`generation` integer NOT NULL,
	`sequence` integer NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`model_name` text DEFAULT '' NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `image_conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_conversation_turns_generation_sequence_idx` ON `image_conversation_turns` (`conversation_id`,`generation`,`sequence`);--> statement-breakpoint
CREATE INDEX `image_conversation_turns_conversation_idx` ON `image_conversation_turns` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `image_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`image_id` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`image_hash` text NOT NULL,
	`prepared_image_base64` text NOT NULL,
	`system_prompt` text NOT NULL,
	`initial_user_text` text NOT NULL,
	`initial_response` text NOT NULL,
	`initial_output_tokens` integer DEFAULT 0 NOT NULL,
	`model_name` text DEFAULT '' NOT NULL,
	`current_generation` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_conversations_chat_image_idx` ON `image_conversations` (`chat_id`,`image_id`);--> statement-breakpoint
ALTER TABLE `image_alt_texts` ADD `seed_system_prompt` text;--> statement-breakpoint
ALTER TABLE `image_alt_texts` ADD `seed_user_text` text;
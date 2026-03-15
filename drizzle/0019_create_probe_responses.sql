CREATE TABLE `probe_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`provider` text NOT NULL,
	`data` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_signature_compat` text DEFAULT '',
	`is_activated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `probe_responses_chat_idx` ON `probe_responses` (`chat_id`);

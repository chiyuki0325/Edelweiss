CREATE TABLE `image_alt_texts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`image_hash` text NOT NULL,
	`alt_text` text NOT NULL,
	`alt_text_tokens` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_alt_texts_hash_idx` ON `image_alt_texts` (`image_hash`);

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`type` text NOT NULL,
	`received_at` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`message_id` text,
	`sender_id` text,
	`text` text,
	`message_ids` text,
	`sender` text,
	`content` text,
	`attachments` text,
	`reply_to_message_id` text,
	`forward_info` text
);--> statement-breakpoint
INSERT INTO `__new_events`("id", "chat_id", "type", "received_at", "timestamp", "message_id", "sender_id", "text", "message_ids", "sender", "content", "attachments", "reply_to_message_id", "forward_info") SELECT "id", "chat_id", "type", "received_at", "timestamp", CAST("message_id" AS TEXT), "sender_id", "text", "message_ids", "sender", NULL, "attachments", CAST("reply_to_message_id" AS TEXT), "forward_info" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_chat_id_idx` ON `events` (`chat_id`);

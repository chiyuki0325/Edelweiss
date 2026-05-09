ALTER TABLE `turn_responses_v2` ADD `agent_id` text NOT NULL DEFAULT 'main';

CREATE INDEX `turn_responses_v2_chat_agent_requested_idx` ON `turn_responses_v2` (`chat_id`, `agent_id`, `requested_at`);

CREATE TABLE `subagents` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `chat_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `task` text NOT NULL,
  `status` text NOT NULL,
  `model_name` text NOT NULL DEFAULT '',
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `final_message` text
);

CREATE UNIQUE INDEX `subagents_chat_agent_idx` ON `subagents` (`chat_id`, `agent_id`);
CREATE INDEX `subagents_chat_status_idx` ON `subagents` (`chat_id`, `status`);

CREATE TABLE `subagent_messages` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `chat_id` text NOT NULL,
  `from_agent_id` text NOT NULL,
  `to_agent_id` text NOT NULL,
  `type` text NOT NULL,
  `content` text NOT NULL,
  `final` integer NOT NULL DEFAULT false,
  `created_at_ms` integer NOT NULL,
  `delivered_at_ms` integer
);

CREATE INDEX `subagent_messages_chat_to_idx` ON `subagent_messages` (`chat_id`, `to_agent_id`);

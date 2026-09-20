CREATE TABLE `agent_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`agent` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`provider` text,
	`model` text,
	`status` text DEFAULT 'complete' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`latency_ms` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_steps_run_idx` ON `agent_steps` (`run_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`risk` text DEFAULT 'medium' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approvals_run_idx` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text DEFAULT 'local' NOT NULL,
	`owner_email` text,
	`prompt` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`final_deliverable` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'prepare' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`connected` integer DEFAULT false NOT NULL,
	`task_class` text DEFAULT 'general' NOT NULL,
	`complexity` integer DEFAULT 2 NOT NULL,
	`strategy` text DEFAULT 'balanced' NOT NULL,
	`active_agents` text DEFAULT '[]' NOT NULL,
	`estimated_tokens` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`revisions` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `runs_owner_created_idx` ON `runs` (`owner_id`,`created_at`);
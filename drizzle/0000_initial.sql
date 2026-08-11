CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`original_text` text NOT NULL,
	`normalized_text` text NOT NULL,
	`content_hash` text NOT NULL,
	`sections_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_project_content_hash_unique` ON `sources` (`project_id`,`content_hash`);
--> statement-breakpoint
CREATE TABLE `generation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`input_hash` text NOT NULL,
	`status` text NOT NULL,
	`raw_output` text,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `generation_runs_project_kind_idx` ON `generation_runs` (`project_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`worldline_id` text,
	`kind` text NOT NULL,
	`schema_version` integer NOT NULL,
	`data_json` text NOT NULL,
	`based_on_artifact_id` text,
	`generation_run_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`based_on_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`generation_run_id`) REFERENCES `generation_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_project_kind_idx` ON `artifacts` (`project_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `worldlines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_worldline_id` text,
	`base_story_map_artifact_id` text NOT NULL,
	`divergence_json` text,
	`mode` text NOT NULL,
	`anchors_json` text NOT NULL,
	`accepted_impact_plan_id` text,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_worldline_id`) REFERENCES `worldlines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_story_map_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_impact_plan_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worldlines_project_idempotency_unique` ON `worldlines` (`project_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `worldlines_project_parent_idx` ON `worldlines` (`project_id`,`parent_worldline_id`);

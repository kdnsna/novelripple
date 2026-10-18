ALTER TABLE `jobs` ADD `model_calls` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `story_map_chunk_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_content_hash` text NOT NULL,
	`run_group_id` text NOT NULL,
	`checkpoint_key` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`stage` text NOT NULL,
	`result_json` text NOT NULL,
	`model_calls` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `story_map_chunk_checkpoints_group_key_idx` ON `story_map_chunk_checkpoints` (`run_group_id`,`checkpoint_key`,`stage`);
--> statement-breakpoint
CREATE INDEX `story_map_chunk_checkpoints_project_source_idx` ON `story_map_chunk_checkpoints` (`project_id`,`source_id`);

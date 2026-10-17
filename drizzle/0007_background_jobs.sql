CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`input_json` text NOT NULL,
	`status` text NOT NULL,
	`progress_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_project_kind_idx` ON `jobs` (`project_id`,`kind`);
--> statement-breakpoint
CREATE INDEX `jobs_status_heartbeat_idx` ON `jobs` (`status`,`heartbeat_at`);

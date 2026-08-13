PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text REFERENCES `sources`(`id`),
	`worldline_id` text REFERENCES `worldlines`(`id`) ON UPDATE no action ON DELETE no action,
	`kind` text NOT NULL,
	`schema_version` integer NOT NULL,
	`version` integer,
	`data_json` text NOT NULL,
	`review_json` text DEFAULT '{"evidenceConfirmations":[]}' NOT NULL,
	`based_on_artifact_id` text,
	`generation_run_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`based_on_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`generation_run_id`) REFERENCES `generation_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_artifacts`(
	`id`,
	`project_id`,
	`source_id`,
	`worldline_id`,
	`kind`,
	`schema_version`,
	`version`,
	`data_json`,
	`review_json`,
	`based_on_artifact_id`,
	`generation_run_id`,
	`created_at`
)
SELECT
	`id`,
	`project_id`,
	`source_id`,
	`worldline_id`,
	`kind`,
	`schema_version`,
	`version`,
	`data_json`,
	`review_json`,
	`based_on_artifact_id`,
	`generation_run_id`,
	`created_at`
FROM `artifacts`;
--> statement-breakpoint
DROP TABLE `artifacts`;
--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;
--> statement-breakpoint
CREATE INDEX `artifacts_project_kind_idx` ON `artifacts` (`project_id`,`kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_story_map_source_version_unique`
ON `artifacts` (`project_id`,`source_id`,`version`)
WHERE `kind` IN ('story_map','story_map_revision')
	AND `source_id` IS NOT NULL
	AND `version` IS NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;

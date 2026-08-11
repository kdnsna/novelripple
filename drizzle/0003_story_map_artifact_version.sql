ALTER TABLE `artifacts` ADD `source_id` text REFERENCES `sources`(`id`);
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `version` integer;
--> statement-breakpoint
UPDATE `artifacts`
SET
	`source_id` = json_extract(`data_json`, '$.sourceId'),
	`version` = CAST(json_extract(`data_json`, '$.version') AS integer)
WHERE `kind` IN ('story_map', 'story_map_revision');
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_story_map_source_version_unique`
ON `artifacts` (`project_id`, `source_id`, `version`)
WHERE `kind` IN ('story_map', 'story_map_revision')
	AND `source_id` IS NOT NULL
	AND `version` IS NOT NULL;

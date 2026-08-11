ALTER TABLE `artifacts` ADD `review_json` text DEFAULT '{"evidenceConfirmations":[]}' NOT NULL;
--> statement-breakpoint
UPDATE `artifacts`
SET `schema_version` = 2
WHERE `kind` IN ('story_map', 'story_map_revision');

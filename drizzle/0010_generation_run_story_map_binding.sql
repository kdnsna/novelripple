ALTER TABLE `generation_runs` ADD `story_map_artifact_id` text REFERENCES `artifacts`(`id`);
--> statement-breakpoint
CREATE INDEX `generation_runs_story_map_kind_idx` ON `generation_runs` (`project_id`,`story_map_artifact_id`,`kind`);

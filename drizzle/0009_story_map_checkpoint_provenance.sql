ALTER TABLE `story_map_chunk_checkpoints` ADD `generation_run_id` text REFERENCES `generation_runs`(`id`);

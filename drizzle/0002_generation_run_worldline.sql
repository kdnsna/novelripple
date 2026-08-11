ALTER TABLE `generation_runs` ADD `worldline_id` text REFERENCES `worldlines`(`id`);

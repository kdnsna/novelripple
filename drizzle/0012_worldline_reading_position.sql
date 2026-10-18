ALTER TABLE `worldlines` ADD `head_node_id` text;
--> statement-breakpoint
CREATE TABLE `worldline_bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`worldline_id` text NOT NULL,
	`scene_node_id` text,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`worldline_id`) REFERENCES `worldlines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worldline_bookmarks_worldline_name_unique` ON `worldline_bookmarks` (`worldline_id`,`name`);
--> statement-breakpoint
CREATE INDEX `worldline_bookmarks_worldline_idx` ON `worldline_bookmarks` (`worldline_id`);

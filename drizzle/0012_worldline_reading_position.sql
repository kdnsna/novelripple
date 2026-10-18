ALTER TABLE `worldlines` ADD `head_kind` text;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `worldline_character_status_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`worldline_id` text NOT NULL,
	`anchor_scene_id` text,
	`character_id` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`worldline_id`) REFERENCES `worldlines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worldline_character_status_overrides_idempotency_unique` ON `worldline_character_status_overrides` (`worldline_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `worldline_character_status_overrides_worldline_idx` ON `worldline_character_status_overrides` (`worldline_id`);

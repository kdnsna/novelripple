ALTER TABLE `worldlines` ADD `head_kind` text CHECK (`head_kind` IN ('root','scene') OR `head_kind` IS NULL);
--> statement-breakpoint
ALTER TABLE `worldlines` ADD `head_node_id` text CHECK ((`head_kind` IS NULL AND `head_node_id` IS NULL) OR (`head_kind` IS 'root' AND `head_node_id` IS NULL) OR (`head_kind` IS 'scene' AND `head_node_id` IS NOT NULL AND trim(`head_node_id`, ' ' || char(9) || char(10) || char(13)) <> ''));
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

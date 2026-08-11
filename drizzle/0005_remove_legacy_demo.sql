DELETE FROM `projects`
WHERE `id` = 'project_ripple_001'
  AND EXISTS (
    SELECT 1
    FROM `sources`
    WHERE `sources`.`id` = 'source_ripple_001'
      AND `sources`.`project_id` = `projects`.`id`
  );

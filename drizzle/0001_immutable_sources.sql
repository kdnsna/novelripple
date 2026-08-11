CREATE TRIGGER `sources_prevent_update`
BEFORE UPDATE ON `sources`
BEGIN
	SELECT RAISE(ABORT, 'Source is immutable');
END;

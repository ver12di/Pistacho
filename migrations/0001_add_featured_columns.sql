-- Migration number: 0001 	 2026-01-05T05:34:38.556Z

ALTER TABLE ratings ADD COLUMN is_featured INTEGER DEFAULT 0;
ALTER TABLE ratings ADD COLUMN featured_content TEXT;

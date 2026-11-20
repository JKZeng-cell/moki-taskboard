export const p23Schema = `
ALTER TABLE panel_settings ADD COLUMN layoutVersion INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0;
CREATE TABLE project_groups(name TEXT PRIMARY KEY, position INTEGER NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0);
INSERT INTO project_groups(name,position) VALUES ('',0);
INSERT OR IGNORE INTO project_groups(name,position) SELECT category,row_number() OVER(ORDER BY category) FROM (SELECT DISTINCT category FROM projects);
WITH ranks AS (SELECT id,row_number() OVER(PARTITION BY category ORDER BY createdAt DESC,id) n FROM projects)
UPDATE projects SET sortOrder=(SELECT n FROM ranks WHERE ranks.id=projects.id);
CREATE TRIGGER project_layout_insert AFTER INSERT ON projects BEGIN
  INSERT OR IGNORE INTO project_groups(name,position) SELECT NEW.category,coalesce(max(position),0)+1 FROM project_groups;
  UPDATE projects SET sortOrder=(SELECT coalesce(max(sortOrder),0)+1 FROM projects WHERE category=NEW.category) WHERE id=NEW.id;
  UPDATE panel_settings SET layoutVersion=layoutVersion+1 WHERE id=1;
END;
CREATE TRIGGER project_layout_update AFTER UPDATE OF category ON projects WHEN NEW.category<>OLD.category BEGIN
  INSERT OR IGNORE INTO project_groups(name,position) SELECT NEW.category,coalesce(max(position),0)+1 FROM project_groups;
  UPDATE projects SET sortOrder=(SELECT coalesce(max(sortOrder),0)+1 FROM projects WHERE category=NEW.category) WHERE id=NEW.id;
  UPDATE panel_settings SET layoutVersion=layoutVersion+1 WHERE id=1;
END;
CREATE TABLE project_policy(projectId TEXT PRIMARY KEY REFERENCES projects(id), mode TEXT NOT NULL DEFAULT 'manual',
  zone TEXT NOT NULL, windows TEXT NOT NULL DEFAULT '[]', paused INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
  capture INTEGER NOT NULL DEFAULT 0, roots TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1);
ALTER TABLE runs ADD COLUMN deadline INTEGER;
ALTER TABLE runs ADD COLUMN stopReason TEXT;
ALTER TABLE runs ADD COLUMN stopAt INTEGER;
ALTER TABLE runs ADD COLUMN parentRunId TEXT;
CREATE TABLE run_approvals(id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES runs(id),threadId TEXT NOT NULL,turnId TEXT NOT NULL,
  itemKey TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',createdAt TEXT NOT NULL,
  UNIQUE(runId,threadId,turnId,itemKey,kind));
CREATE TABLE asset_edits(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),assetId TEXT NOT NULL REFERENCES assets(id),
  baseId TEXT NOT NULL REFERENCES asset_versions(id),fileName TEXT NOT NULL,createdAt TEXT NOT NULL,savedId TEXT REFERENCES asset_versions(id));
CREATE TABLE thread_links(threadId TEXT PRIMARY KEY,projectId TEXT REFERENCES projects(id),taskId TEXT REFERENCES tasks(id),cwd TEXT NOT NULL,
  name TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',parentId TEXT,kind TEXT NOT NULL,choices TEXT NOT NULL DEFAULT '[]',
  seenAt INTEGER NOT NULL DEFAULT -1,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE capture_items(threadId TEXT NOT NULL REFERENCES thread_links(threadId),turnId TEXT NOT NULL,anchor TEXT NOT NULL,
  projectId TEXT NOT NULL REFERENCES projects(id),taskId TEXT REFERENCES tasks(id),title TEXT NOT NULL,created INTEGER NOT NULL DEFAULT 0,
  taskVersion INTEGER,status TEXT NOT NULL,PRIMARY KEY(threadId,turnId,anchor));
CREATE INDEX captured_project ON capture_items(projectId,status);
CREATE TABLE capture_cursors(scope TEXT PRIMARY KEY, cursor TEXT,watermark INTEGER NOT NULL DEFAULT 0,high INTEGER NOT NULL DEFAULT 0);
PRAGMA user_version=6;
`;

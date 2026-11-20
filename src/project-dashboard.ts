import { activityStart, defaultActivityWeeks, localDay, type ActivityWeeks } from "./calendar.ts";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { ActivityDay, ConversationUpdate, Params, ProjectRelease } from "./types.ts";
import { expectedVersion, id, text } from "./validation.ts";

export const dashboardSchema = `
  CREATE TABLE project_releases(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
    label TEXT COLLATE NOCASE NOT NULL, releasedOn TEXT NOT NULL, notes TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(projectId,label));
  CREATE INDEX release_history ON project_releases(projectId,releasedOn DESC);
  CREATE TABLE task_activity(taskId TEXT NOT NULL REFERENCES tasks(id), at TEXT NOT NULL, PRIMARY KEY(taskId,at));
  INSERT OR IGNORE INTO task_activity SELECT id,createdAt FROM tasks;
  INSERT OR IGNORE INTO task_activity SELECT id,updatedAt FROM tasks;
  INSERT OR IGNORE INTO task_activity SELECT taskId,startedAt FROM runs;
  INSERT OR IGNORE INTO task_activity SELECT taskId,endedAt FROM runs WHERE endedAt IS NOT NULL;
  INSERT OR IGNORE INTO task_activity SELECT taskId,createdAt FROM task_reviews;
  CREATE TRIGGER activity_create AFTER INSERT ON tasks BEGIN
    INSERT OR IGNORE INTO task_activity VALUES(new.id,new.createdAt); END;
  CREATE TRIGGER activity_status AFTER UPDATE OF updatedAt,status ON tasks WHEN new.updatedAt<>old.updatedAt OR new.status<>old.status BEGIN
    INSERT OR IGNORE INTO task_activity VALUES(new.id,new.updatedAt); END;
  CREATE TABLE conversation_updates(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
    threadId TEXT NOT NULL, turnId TEXT NOT NULL, itemId TEXT NOT NULL, taskId TEXT REFERENCES tasks(id),
    runId TEXT REFERENCES runs(id), kind TEXT NOT NULL CHECK(kind IN ('progress','handoff')), author TEXT NOT NULL,
    summary TEXT NOT NULL, quote TEXT NOT NULL, occurredAt TEXT NOT NULL, replacesId TEXT REFERENCES conversation_updates(id) ON DELETE SET NULL);
  CREATE INDEX updates_project_time ON conversation_updates(projectId,occurredAt DESC);
  CREATE INDEX updates_thread ON conversation_updates(threadId);
  CREATE INDEX updates_superseded ON conversation_updates(replacesId);
  DELETE FROM semantic_jobs WHERE threadId IN (SELECT threadId FROM thread_links WHERE projectId IS NOT NULL AND kind IN ('auto','manual'));
  PRAGMA user_version=10;
`;

export function saveRelease(db: Store, p: Params) {
  return db.transaction(() => {
    const project = db.project(p.projectId, true);
    const label = text(p.label, "上线版本", 80), notes = text(p.notes, "更新说明", 4000, true);
    const day = text(p.releasedOn, "上线日期", 10);
    const parsed = new Date(day + "T12:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0,10) !== day || day > localDay(new Date()))
      throw new Error("请选择有效的已上线日期。");
    const releaseId = p.id ? id(p.id) : randomUUID();
    if (db.get("SELECT 1 FROM project_releases WHERE projectId=? AND label=? AND id<>?", project.id, label, releaseId))
      throw new Error("项目中已登记此版本。");
    if (p.id) {
      const prior = db.get<ProjectRelease>("SELECT * FROM project_releases WHERE id=? AND projectId=?", releaseId, project.id);
      if (!prior || prior.version !== expectedVersion(p.version)) throw new Error("上线版本已有更新，请刷新后再操作。");
      db.write("UPDATE project_releases SET label=?,releasedOn=?,notes=?,version=version+1 WHERE id=?", label, day, notes, releaseId);
    } else db.write("INSERT INTO project_releases(id,projectId,label,releasedOn,notes) VALUES(?,?,?,?,?)", releaseId, project.id, label, day, notes);
    return { id: releaseId };
  });
}

export function activityDays(db: Store, projectId: string, weeks: ActivityWeeks = defaultActivityWeeks, today = new Date()): ActivityDay[] {
  const from = activityStart(today, weeks).toISOString();
  const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
  const rows = db.all<{ day: string; taskId: string }>(`
    SELECT date(a.at,'localtime') day,t.id taskId FROM tasks t JOIN task_activity a ON a.taskId=t.id
    WHERE t.projectId=? AND t.lifecycle<>'trash' AND a.at>=? AND a.at<?
    UNION SELECT date(u.occurredAt,'localtime'),t.id FROM conversation_updates u JOIN tasks t ON t.id=u.taskId
    WHERE u.projectId=? AND t.lifecycle<>'trash' AND u.occurredAt>=? AND u.occurredAt<? ORDER BY 1,2`,
    projectId, from, until, projectId, from, until);
  const days = new Map<string,string[]>();
  for (const row of rows) {
    const tasks = days.get(row.day);
    if (tasks) tasks.push(row.taskId); else days.set(row.day, [row.taskId]);
  }
  return Array.from(days, ([day, taskIds]) => ({ day, taskIds }));
}

const openHandoff = "u.kind='handoff' AND NOT EXISTS(SELECT 1 FROM conversation_updates newer WHERE newer.replacesId=u.id)";
export function handoffFor(db: Store, projectId: string, taskId?: string) {
  const fields = "u.id,u.summary,u.quote,u.author,u.threadId,u.turnId,u.occurredAt,u.taskId";
  return db.all<Pick<ConversationUpdate, "id"|"summary"|"quote"|"author"|"threadId"|"turnId"|"occurredAt"|"taskId">>(
    `SELECT ${fields} FROM conversation_updates u WHERE u.projectId=? AND ${openHandoff}
    ${taskId ? "AND (u.taskId IS NULL OR u.taskId=?)" : ""} ORDER BY u.occurredAt DESC,u.rowid DESC`,
    ...(taskId ? [projectId, taskId] : [projectId]));
}

export function dashboard(db: Store, projectId: string, activityWeeks: ActivityWeeks = defaultActivityWeeks) {
  return {
    activityWeeks,
    activity: activityDays(db, projectId, activityWeeks),
    releases: db.all<ProjectRelease>("SELECT * FROM project_releases WHERE projectId=? ORDER BY releasedOn DESC,rowid DESC", projectId),
    updates: db.all<ConversationUpdate>(`SELECT u.*,(${openHandoff}) current FROM conversation_updates u
      WHERE u.projectId=? ORDER BY u.occurredAt DESC,u.rowid DESC`, projectId),
  };
}


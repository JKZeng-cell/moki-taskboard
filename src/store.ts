import { hostName } from "./host-identity.ts";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { CollectedFile, Delivery, StoredFile } from "./assets.ts";
import type { TaskAttachment } from "./attachments.ts";
import type {
  Asset, AssetVersion, AssetView, BoardState, CapturedState, Check, InputFile, Lifecycle, Params, Project, ProjectListItem,
  Run, RunRecord, RunStatus, Snapshot, Task, TaskReview, TaskStatus
} from "./types.ts";
import { array, expectedVersion, id, taskFields, text } from "./validation.ts";
import { canRefineStatus, isTaskStatus, startableStatuses } from "./workflow.ts";
import { p23Schema } from "./p23-schema.ts";
import { assertSessionChoice, sessionChoice } from "./session-routing.ts";
import { layoutState } from "./panel-layout.ts";
import { policyFor, scheduleWindow } from "./schedule.ts";
import { dashboard, dashboardSchema, handoffFor } from "./project-dashboard.ts";
import { defaultActivityWeeks, type ActivityWeeks } from "./calendar.ts";
import { conversationFileSchema, conversationInputs } from "./conversation-files.ts";
import { sessionState } from "./capture.ts";

const schema = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, root TEXT NOT NULL,
  rootKey TEXT NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'active', restoreAs TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1, handoffVersionId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, instructions TEXT NOT NULL,
  expectedFiles TEXT NOT NULL, textChecks TEXT NOT NULL, reviewCriteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo', lifecycle TEXT NOT NULL DEFAULT 'active', restoreAs TEXT NOT NULL DEFAULT 'active',
  queueRank INTEGER, version INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, role TEXT NOT NULL,
  sourcePath TEXT NOT NULL, sourceKey TEXT NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'active',
  restoreAs TEXT NOT NULL DEFAULT 'active', context INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS imported_asset ON assets(projectId, sourceKey) WHERE role='user';
CREATE TABLE IF NOT EXISTS asset_versions (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL REFERENCES assets(id), revision INTEGER NOT NULL,
  fileName TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, createdAt TEXT NOT NULL,
  UNIQUE(assetId, revision)
);
CREATE TABLE IF NOT EXISTS task_inputs (
  taskId TEXT NOT NULL REFERENCES tasks(id), versionId TEXT NOT NULL REFERENCES asset_versions(id),
  PRIMARY KEY(taskId, versionId)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), projectId TEXT NOT NULL REFERENCES projects(id),
  rootKey TEXT NOT NULL, requestKey TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
  phase TEXT NOT NULL DEFAULT '已领取', workDir TEXT NOT NULL, threadId TEXT, turnId TEXT, modelStatus TEXT,
  startedAt TEXT NOT NULL, endedAt TEXT, stopRequested INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', checks TEXT NOT NULL DEFAULT '[]',
  reviewNote TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS live_project ON runs(projectId) WHERE status IN ('running','recover');
CREATE UNIQUE INDEX IF NOT EXISTS live_directory ON runs(rootKey) WHERE status IN ('running','recover');
CREATE TABLE IF NOT EXISTS run_files (
  runId TEXT NOT NULL REFERENCES runs(id), versionId TEXT NOT NULL REFERENCES asset_versions(id),
  path TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(runId,path)
);
CREATE TABLE IF NOT EXISTS run_events (
  seq INTEGER PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id), at TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks(projectId,lifecycle,status,queueRank);
CREATE INDEX IF NOT EXISTS runs_by_project ON runs(projectId,startedAt);
`;

type TaskRow = Omit<Task, "expectedFiles" | "textChecks" | "inputVersionIds" | "reviews"> & {
  expectedFiles: string; textChecks: string; restoreAs: Lifecycle;
};
type RunRow = Omit<Run, "checks" | "files"> & { checks: string; snapshot: string };
type ProjectRow = Project & { rootKey: string; restoreAs: Lifecycle };
type AssetRow = Omit<Asset, "versions"> & { projectId: string; restoreAs: Lifecycle };
type WritableRow = { id: string; version: number; lifecycle: Lifecycle; restoreAs: Lifecycle };

const now = () => new Date().toISOString();
const keyPath = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const activeStatuses = ["running", "recover"];

type RefinementInputs = { versionIds: string[]; fingerprint?: string };

function attachmentIdentity(attachments: TaskAttachment[]) {
  return attachments.map(({source,file}) => [source, file.fileName, file.sha256]);
}

export class Store {
  readonly root: string;
  readonly db: DatabaseSync;

  constructor(root: string) {
    this.root = root;
    this.db = new DatabaseSync(join(root, "taskboard.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    this.transaction(() => {
      const migration = this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
      if (migration > 13) throw new Error("任务台数据由更高版本创建。");
      if (!migration) this.db.exec(schema);
      if (migration < 2) this.db.exec(`
        ALTER TABLE projects ADD COLUMN preferredModel TEXT;
        ALTER TABLE projects ADD COLUMN preferredEffort TEXT;
        ALTER TABLE runs ADD COLUMN effectiveModel TEXT;
        ALTER TABLE runs ADD COLUMN effectiveEffort TEXT;
        CREATE TABLE quick_requests (
          requestKey TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          taskId TEXT NOT NULL REFERENCES tasks(id), runId TEXT REFERENCES runs(id)
        );
        CREATE TABLE panel_settings (id INTEGER PRIMARY KEY CHECK(id=1), composerMinimized INTEGER NOT NULL);
        INSERT INTO panel_settings VALUES (1,0);
        PRAGMA user_version=2;
      `);
      if (migration < 3) this.db.exec(`
        ALTER TABLE panel_settings ADD COLUMN sidebarCollapsed INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=3;
      `);
      if (migration < 4) this.db.exec(`
        ALTER TABLE projects ADD COLUMN category TEXT NOT NULL DEFAULT '';
        ALTER TABLE assets ADD COLUMN groupName TEXT NOT NULL DEFAULT '';
        ALTER TABLE runs ADD COLUMN totalTokens INTEGER;
        ALTER TABLE runs ADD COLUMN inputTokens INTEGER;
        ALTER TABLE runs ADD COLUMN outputTokens INTEGER;
        ALTER TABLE runs ADD COLUMN turnDurationMs INTEGER;
        PRAGMA user_version=4;
      `);
      if (migration < 5) this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_reviews (
          seq INTEGER PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), runId TEXT REFERENCES runs(id),
          decision TEXT NOT NULL, note TEXT NOT NULL, createdAt TEXT NOT NULL, requestKey TEXT UNIQUE
        );
        CREATE INDEX IF NOT EXISTS reviews_by_task ON task_reviews(taskId,seq);
        PRAGMA user_version=5;
      `);
      if (migration < 6) this.db.exec(p23Schema);
      if(migration<7)this.db.exec(`CREATE TABLE capture_refs(threadId TEXT NOT NULL REFERENCES thread_links(threadId),turnId TEXT NOT NULL,
        projectId TEXT NOT NULL REFERENCES projects(id),versionId TEXT NOT NULL REFERENCES asset_versions(id),path TEXT NOT NULL,
        PRIMARY KEY(threadId,turnId,versionId));
        CREATE TABLE run_checkpoints(runId TEXT PRIMARY KEY REFERENCES runs(id),recordedAt INTEGER NOT NULL,delivery TEXT NOT NULL,safe INTEGER NOT NULL);
        PRAGMA user_version=7;`);
      if (migration < 8) this.db.exec(`
        ALTER TABLE panel_settings ADD COLUMN assetView TEXT NOT NULL DEFAULT 'list' CHECK(assetView IN ('list','cards'));
        PRAGMA user_version=8;
      `);
      if (migration < 9) this.db.exec(`
        ALTER TABLE project_policy ADD COLUMN semanticScope TEXT NOT NULL DEFAULT 'off' CHECK(semanticScope IN ('off','roots','all'));
        ALTER TABLE thread_links ADD COLUMN matchBasis TEXT NOT NULL DEFAULT 'directory';
        ALTER TABLE thread_links ADD COLUMN matchReason TEXT NOT NULL DEFAULT '';
        ALTER TABLE capture_items ADD COLUMN evidence TEXT NOT NULL DEFAULT '';
        CREATE TABLE thread_match_evidence(threadId TEXT NOT NULL REFERENCES thread_links(threadId) ON DELETE CASCADE,
          projectId TEXT NOT NULL REFERENCES projects(id), reason TEXT NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(threadId,projectId));
        CREATE TABLE semantic_jobs(threadId TEXT PRIMARY KEY, scope TEXT NOT NULL, projectIds TEXT NOT NULL,
          wanted INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT -1, queuedAt INTEGER NOT NULL, retryAt INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
        CREATE INDEX semantic_due ON semantic_jobs(retryAt,queuedAt) WHERE processed < wanted;
        CREATE TABLE semantic_receipts(threadId TEXT NOT NULL REFERENCES semantic_jobs(threadId) ON DELETE CASCADE,
          digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(threadId,digest));
        PRAGMA user_version=9;
      `);
      if (migration < 10) this.db.exec(dashboardSchema);
      if (migration < 11) this.db.exec(`
        ALTER TABLE capture_items ADD COLUMN stateProof TEXT;
        DELETE FROM semantic_jobs WHERE threadId IN (
          SELECT c.threadId FROM capture_items c JOIN tasks t ON t.id=c.taskId JOIN project_policy p ON p.projectId=c.projectId
          WHERE c.created=1 AND c.status='active' AND c.evidence<>'' AND c.taskVersion=t.version
            AND t.lifecycle='active' AND p.capture=1 AND p.semanticScope<>'off'
            AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.taskId=t.id));
        PRAGMA user_version=11;`);
      if (migration < 12) this.db.exec(conversationFileSchema);
      if (migration < 13) this.db.exec(`CREATE TABLE IF NOT EXISTS project_permissions(projectId TEXT PRIMARY KEY REFERENCES projects(id), preset TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS run_routes(runId TEXT PRIMARY KEY REFERENCES runs(id), kind TEXT NOT NULL, reason TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS approvals_pending ON run_approvals(status,createdAt) WHERE status='pending';
        CREATE INDEX IF NOT EXISTS runs_project_thread ON runs(projectId,threadId,startedAt);
        PRAGMA user_version=13;`);
    });
  }

  get<T>(sql: string, ...values: SQLInputValue[]) {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }

  all<T>(sql: string, ...values: SQLInputValue[]) {
    return this.db.prepare(sql).all(...values) as T[];
  }

  write(sql: string, ...values: SQLInputValue[]) {
    return this.db.prepare(sql).run(...values);
  }

  transaction<T>(action: () => T): T {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT taskboard_write" : "BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec(nested ? "RELEASE taskboard_write" : "COMMIT");
      return result;
    } catch (error) {
      if (nested) this.db.exec("ROLLBACK TO taskboard_write; RELEASE taskboard_write");
      else this.db.exec("ROLLBACK");
      throw error;
    }
  }

  project(value: unknown, active = false) {
    const row = this.get<ProjectRow>("SELECT p.*, coalesce(s.preset,'default') permission FROM projects p LEFT JOIN project_permissions s ON s.projectId=p.id WHERE p.id=?", id(value));
    if (!row) throw new Error("找不到项目。");
    if (active && row.lifecycle !== "active") throw new Error("请先恢复项目。");
    return row;
  }

  taskRow(value: unknown, active = false) {
    const row = this.get<TaskRow>("SELECT * FROM tasks WHERE id=?", id(value));
    if (!row) throw new Error("找不到任务。");
    if (active && row.lifecycle !== "active") throw new Error("请先恢复任务。");
    return row;
  }

  task(row: TaskRow): Task {
    return {
      ...row,
      expectedFiles: JSON.parse(row.expectedFiles),
      textChecks: JSON.parse(row.textChecks),
      reviews: this.all<TaskReview>("SELECT seq,runId,decision,note,createdAt FROM task_reviews WHERE taskId=? ORDER BY seq", row.id),
      inputVersionIds: this.all<{ versionId: string }>(
        "SELECT versionId FROM task_inputs WHERE taskId=? ORDER BY rowid", row.id
      ).map(input => input.versionId)
    };
  }

  assertVersion(row: WritableRow, value: unknown) {
    if (row.version !== expectedVersion(value)) throw new Error("记录已有更新，请刷新后再操作。");
  }

  state(selected?: unknown, projectsOnly = false, activityWeeks: ActivityWeeks = defaultActivityWeeks): BoardState {
    const settings = this.get<{ composerMinimized: number; sidebarCollapsed: number; assetView: AssetView }>(
      "SELECT composerMinimized, sidebarCollapsed, assetView FROM panel_settings WHERE id=1")!;
    const panel = { ...layoutState(this), assetView: settings.assetView, composerMinimized: Boolean(settings.composerMinimized), sidebarCollapsed: Boolean(settings.sidebarCollapsed) };
    const projects = this.all<ProjectListItem>(`
      SELECT p.*, coalesce(s.preset,'default') permission, count(t.id) AS total, count(CASE WHEN t.status='done' THEN 1 END) AS done,
        count(CASE WHEN t.status='queued' THEN 1 END) AS queued, count(CASE WHEN t.status='running' THEN 1 END) AS running,
        count(CASE WHEN t.status='todo' THEN 1 END) AS todo, count(CASE WHEN t.status='review' THEN 1 END) AS review,
        count(CASE WHEN t.status='error' THEN 1 END) AS error, count(CASE WHEN t.status='paused' THEN 1 END) AS paused,
        (SELECT r.status FROM runs r WHERE r.projectId=p.id AND r.status IN ('running','recover')) AS liveRunStatus
      FROM projects p LEFT JOIN project_permissions s ON s.projectId=p.id LEFT JOIN tasks t ON t.projectId=p.id AND t.lifecycle='active'
      GROUP BY p.id ORDER BY p.sortOrder,p.createdAt DESC,p.id
    `);
    const project = projectsOnly ? undefined : selected ? projects.find(item => item.id === selected) :
      projects.find(item => item.lifecycle === "active");
    if (!project) return { ...panel, projects, project: null, tasks: [], assets: [], runs: [], policy:null, sessions:{links:[],sources:[]}, edits:[] };
    const tasks = this.all<TaskRow>(`
      SELECT * FROM tasks WHERE projectId=? ORDER BY status='queued' DESC, queueRank, createdAt DESC, id
    `, project.id).map(row => this.task(row));
    const assets = this.all<AssetRow>("SELECT * FROM assets WHERE projectId=? ORDER BY rowid DESC", project.id)
      .map(asset => ({ ...asset, versions: this.all<AssetVersion>(
        "SELECT * FROM asset_versions WHERE assetId=? ORDER BY revision DESC", asset.id
      ) }));
    const runs = this.all<RunRow>("SELECT * FROM runs WHERE projectId=? ORDER BY startedAt DESC, rowid DESC", project.id)
      .map(row => {
        const { snapshot, ...run } = this.toRun(row);
        const refinementAttachments = snapshot.files.filter(file => file.refinementAttachment)
          .map(({id,fileName,revision}) => ({id,fileName,revision}));
        return {...run,refinementAttachments,permission:snapshot.permission,inputVersionIds:snapshot.files.map(file => file.id),criteria:{reviewCriteria:snapshot.reviewCriteria,expectedFiles:snapshot.expectedFiles,textChecks:snapshot.textChecks}};
      });
    return { ...panel, projects, project, tasks, assets, runs, dashboard:dashboard(this, project.id, activityWeeks), policy:policyFor(this,project.id),sessions:sessionState(this,project.id),
      edits:this.all("SELECT id,assetId,baseId,fileName,createdAt FROM asset_edits WHERE projectId=? AND savedId IS NULL ORDER BY createdAt",project.id) };
  }

  setComposerMinimized(value: unknown) {
    if (typeof value !== "boolean") throw new Error("输入框状态无效。");
    this.write("UPDATE panel_settings SET composerMinimized=? WHERE id=1", Number(value));
    return value;
  }

  setAssetView(view: unknown) {
    if (view !== "list" && view !== "cards") throw new Error("资产视图无效。");
    this.write("UPDATE panel_settings SET assetView=? WHERE id=1", view);
    return view;
  }

  setSidebarCollapsed(value: unknown) {
    if (typeof value !== "boolean") throw new Error("侧栏状态无效。");
    this.write("UPDATE panel_settings SET sidebarCollapsed=? WHERE id=1", Number(value));
    return value;
  }

  saveProject(values: Params, root: string) {
    return this.transaction(() => {
      const saved = this.writeProject(values, root);
      if (values.permission !== undefined) {
        const preset = text(values.permission,"项目默认权限",160);
        this.write("INSERT INTO project_permissions(projectId,preset) VALUES (?,?) ON CONFLICT(projectId) DO UPDATE SET preset=excluded.preset",saved.id,preset);
      }
      return saved;
    });
  }

  private writeProject(values: Params, root: string) {
    const title = text(values.title, "项目名", 160);
    const category = text(values.category, "项目分类", 60, true);
    const description = text(values.description, "项目目标", 8000, true);
    const model = text(values.preferredModel ?? "", "优先模型", 200, true) || null;
    const effort = text(values.preferredEffort ?? "", "推理强度", 40, true) || null;
    const stamp = now();
    if (!values.id) {
      const projectId = randomUUID();
      this.write("INSERT INTO projects(id,title,description,root,rootKey,category,preferredModel,preferredEffort,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
        projectId, title, description, root, keyPath(root), category, model, effort, stamp, stamp);
      return { id: projectId };
    }
    return this.transaction(() => {
      const row = this.project(values.id, true);
      this.assertVersion(row, values.version);
      if (row.rootKey !== keyPath(root) && this.hasActiveRun(row.id)) throw new Error("任务运行期间请保留项目目录。");
      this.write(`UPDATE projects SET title=?,description=?,root=?,rootKey=?,category=?,preferredModel=?,preferredEffort=?,
        version=version+1,updatedAt=? WHERE id=?`, title, description, root, keyPath(root),
        values.category === undefined ? row.category : category,
        values.preferredModel === undefined ? row.preferredModel : model,
        values.preferredEffort === undefined ? row.preferredEffort : effort, stamp, row.id);
      return { id: row.id };
    });
  }

  hasActiveRun(projectId: string) {
    return Boolean(this.get("SELECT id FROM runs WHERE projectId=? AND status IN ('running','recover')", projectId));
  }

  changeLifecycle(table: "projects" | "tasks" | "assets", values: Params) {
    const next = values.lifecycle;
    if (next !== "active" && next !== "archived" && next !== "trash") throw new Error("生命周期状态无效。");
    return this.transaction(() => {
      const rowId = id(values.id);
      const row = this.get<WritableRow & { projectId?: string }>(`SELECT * FROM ${table} WHERE id=?`, rowId);
      if (!row) throw new Error("找不到所选记录。");
      this.assertVersion(row, values.version);
      if (row.projectId) this.project(row.projectId, true);
      if (table === "projects" && next !== "active" && this.hasActiveRun(row.id)) {
        throw new Error("项目有正在执行或待核对的任务。");
      }
      if (table === "tasks" && this.get("SELECT id FROM runs WHERE projectId=? AND taskId=? AND status IN ('running','recover')",
        row.projectId!, rowId)) throw new Error("请先停止任务并确认回执。");
      if (next === row.lifecycle) return { id: rowId, lifecycle: row.lifecycle };
      if(table==="projects"&&next!=="active")this.write("UPDATE project_policy SET paused=1,reason='项目已归档或移入回收站',version=version+1 WHERE projectId=?",rowId);
      const restore = row.lifecycle === "trash" ? row.restoreAs : row.lifecycle;
      const target = next === "active" && row.lifecycle === "trash" ? restore : next;
      if (table === "assets") {
        this.write("UPDATE assets SET lifecycle=?,restoreAs=?,version=version+1 WHERE id=?", target, restore, rowId);
      } else {
        this.write(`UPDATE ${table} SET lifecycle=?,restoreAs=?,version=version+1,updatedAt=? WHERE id=?`,
          target, restore, now(), rowId);
      }
      return { id: rowId, lifecycle: target };
    });
  }

  saveTask(values: Params, attachments: TaskAttachment[] = []) {
    return this.transaction(() => {
      if (!attachments.length) return this.writeTask(values);
      const projectId = values.id ? this.taskRow(values.id, true).projectId : values.projectId;
      const added = this.importFiles(projectId, attachments);
      return this.writeTask({...values, inputVersionIds:[...array(values.inputVersionIds ?? [], "关联资产"), ...added.map(item => item.versionId)]});
    });
  }

  createCapturedTask(projectId:string,title:string,instructions:string,initialStatus:TaskStatus="todo") {
    return this.writeTask({projectId,title,instructions,initialStatus,reviewCriteria:"对照来源会话中的要求核对交付。"}).id;
  }

  private writeTask(values: Params) {
    const data = taskFields(values);
    const row = values.id ? this.taskRow(values.id, true) : null;
    const project = this.project(row?.projectId ?? values.projectId, true);
    const taskId = row?.id ?? randomUUID();
    if (row) this.assertVersion(row, values.version);
    for (const versionId of data.inputVersionIds) this.version(project.id, versionId);
    const fields = [data.title, data.instructions, JSON.stringify(data.expectedFiles),
      JSON.stringify(data.textChecks), data.reviewCriteria];
    const stamp = now();
    if (row) {
      this.write(`
        UPDATE tasks SET title=?,instructions=?,expectedFiles=?,textChecks=?,reviewCriteria=?,updatedAt=?,version=version+1
        WHERE id=?
      `, ...fields, stamp, taskId);
    } else {
      const status = values.initialStatus === undefined ? "todo" : values.initialStatus;
      if (!isTaskStatus(status)) throw new Error("任务状态无效。");
      const rank = status === "queued" ? this.nextQueueRank(project.id) : null;
      this.write(`
        INSERT INTO tasks(id,projectId,title,instructions,expectedFiles,textChecks,reviewCriteria,status,queueRank,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `, taskId, project.id, ...fields, status, rank, stamp, stamp);
    }
    this.write("DELETE FROM task_inputs WHERE taskId=?", taskId);
    for (const versionId of data.inputVersionIds) {
      this.write("INSERT INTO task_inputs(taskId,versionId) VALUES (?,?)", taskId, versionId);
    }
    return { id: taskId };
  }

  quickCreate(values: Params, attachments: TaskAttachment[] = []) {
    const projectId = id(values.projectId);
    const requestKey = id(values.requestKey);
    const instructions = text(values.instructions, "任务说明", 18000);
    const timing = values.timing;
    if (timing !== "todo" && timing !== "now") throw new Error("请选择执行时间。");
    const identity: unknown[] = [projectId, instructions, timing];
    const form = values.title === undefined ? undefined : taskFields(values);
    if (form) identity.push(form);
    const choice=sessionChoice(values.sessionChoice);
    if(timing==="now" && choice.mode!=="auto") identity.push(choice);
    if (attachments.length) identity.push(attachmentIdentity(attachments));
    const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    return this.transaction(() => {
      const previous = this.get<{ fingerprint: string; taskId: string; runId: string | null }>(
        "SELECT * FROM quick_requests WHERE requestKey=?", requestKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("快捷创建请求标识已使用。");
        return { projectId, taskId: previous.taskId, runId: previous.runId, created: false };
      }
      const firstLine = [...instructions.split(/\r?\n/, 1)[0]];
      const title = form?.title ?? (firstLine.length > 64 ? firstLine.slice(0, 63).join("") + "…" : firstLine.join(""));
      const inputs = attachments.length ? this.importFiles(projectId, attachments) : [];
      const inputVersionIds = [...(form?.inputVersionIds ?? []), ...inputs.map(item => item.versionId)];
      const { id: taskId } = this.writeTask({ ...form, projectId, title, instructions, inputVersionIds });
      const runId = timing === "now" ? this.claimRun({ id: taskId, version: 1, requestKey, sessionChoice:choice }, false).id : null;
      this.write("INSERT INTO quick_requests(requestKey,fingerprint,taskId,runId) VALUES (?,?,?,?)",
        requestKey, fingerprint, taskId, runId);
      return { projectId, taskId, runId, created: true };
    });
  }

  private nextQueueRank(projectId: string) {
    return (this.get<{ value: number }>("SELECT coalesce(max(queueRank),0) AS value FROM tasks WHERE projectId=?",
      projectId)?.value ?? 0) + 1;
  }

  private writeTaskStatus(task: TaskRow, status: TaskStatus) {
    const rank = status === "queued" ? this.nextQueueRank(task.projectId) : null;
    this.write("UPDATE tasks SET status=?,queueRank=?,version=version+1,updatedAt=? WHERE id=?",
      status, rank, now(), task.id);
  }

  applyCapturedState(projectId: string, threadId: string, taskId: string, proof: CapturedState) {
    const owner = this.get<{ rowid:number; threadId:string; stateProof:string|null }>(`
      SELECT c.rowid,c.threadId,c.stateProof FROM capture_items c JOIN tasks t ON c.taskId=t.id AND c.taskVersion=t.version
      WHERE c.projectId=? AND c.taskId=? AND c.created=1 AND c.status='active'
        AND EXISTS(SELECT 1 FROM thread_links l WHERE l.threadId=? AND l.projectId=c.projectId AND l.kind IN ('auto','manual'))
        AND t.lifecycle='active' AND NOT EXISTS (SELECT 1 FROM runs WHERE taskId=t.id)
        AND NOT EXISTS (SELECT 1 FROM task_reviews WHERE taskId=t.id)`,projectId,taskId,threadId);
    if (!owner) return;
    const prior: CapturedState | null = owner.stateProof ? JSON.parse(owner.stateProof) : null;
    const priorThread = prior?.threadId ?? owner.threadId;
    if (prior && (priorThread === threadId && proof.turnId === prior.turnId
      ? proof.itemIndex < prior.itemIndex || (proof.itemIndex === prior.itemIndex && proof.offset <= prior.offset)
      : proof.at < prior.at || (proof.at === prior.at && priorThread !== threadId))) return;
    const task = this.taskRow(taskId);
    if (task.status !== proof.status) this.writeTaskStatus(task,proof.status);
    this.write("UPDATE capture_items SET stateProof=?,taskVersion=? WHERE rowid=?",
      JSON.stringify({...proof,threadId}),this.taskRow(taskId).version,owner.rowid);
  }

  changeTaskStatus(values: Params) {
    const status = values.status;
    if (!isTaskStatus(status)) throw new Error("任务状态无效。");
    return this.transaction(() => {
      const task = this.taskRow(values.id, true);
      this.project(task.projectId, true);
      this.assertVersion(task, values.version);
      if (task.status === status) return { id: task.id };
      if (task.status === "review" && status === "done") {
        this.applyReview(task, this.pendingReview(task), "accept", "");
        return { id: task.id };
      }
      const run = this.controllingRun(task);
      if (run) throw new Error(run.status === "review" ? "请在执行记录中提交验收结论。" : "请等待 "+hostName+" 执行结束或确认中断回执。");
      this.writeTaskStatus(task, status);
      return { id: task.id };
    });
  }

  queue(values: Params, action: "add" | "remove" | "reopen" | "move") {
    return this.transaction(() => {
      const task = this.taskRow(values.id, true);
      this.project(task.projectId, true);
      this.assertVersion(task, values.version);
      if (action === "move") {
        if (task.status !== "queued" || task.queueRank === null) throw new Error("任务须先进入队列。");
        if (values.direction !== "up" && values.direction !== "down") throw new Error("队列方向无效。");
        const before = values.direction === "up";
        const next = this.get<TaskRow>(`
          SELECT * FROM tasks WHERE projectId=? AND lifecycle='active' AND status='queued' AND queueRank ${before ? "<" : ">"} ?
          ORDER BY queueRank ${before ? "DESC" : "ASC"} LIMIT 1
        `, task.projectId, task.queueRank);
        if (next) {
          const stamp = now();
          this.write("UPDATE tasks SET queueRank=?,version=version+1,updatedAt=? WHERE id=?", next.queueRank, stamp, task.id);
          this.write("UPDATE tasks SET queueRank=?,version=version+1,updatedAt=? WHERE id=?", task.queueRank, stamp, next.id);
        }
      } else {
        if (action === "add") {
          if (!["todo", "paused", "error"].includes(task.status)) throw new Error("任务当前无法入队。");
        } else if (action === "remove" ? task.status !== "queued" : !["done", "paused", "error"].includes(task.status)) {
          throw new Error("任务当前无法移回待办。");
        }
        this.writeTaskStatus(task, action === "add" ? "queued" : "todo");
      }
      return { id: task.id };
    });
  }

  version(projectId: string, value: unknown) {
    const result = this.get<AssetVersion & { name: string }>(`
      SELECT v.*, a.name FROM asset_versions v JOIN assets a ON a.id=v.assetId
      WHERE a.projectId=? AND v.id=?
    `, projectId, id(value));
    if (!result) throw new Error("找不到项目内的资产版本。");
    return result;
  }

  addVersion(assetId: string, file: StoredFile) {
    const latest = this.get<AssetVersion>("SELECT * FROM asset_versions WHERE assetId=? ORDER BY revision DESC LIMIT 1", assetId);
    if (latest?.sha256 === file.sha256) return latest.id;
    const versionId = randomUUID();
    this.write("INSERT INTO asset_versions(id,assetId,revision,fileName,sha256,size,createdAt) VALUES (?,?,?,?,?,?,?)",
      versionId, assetId, (latest?.revision ?? 0) + 1, file.fileName, file.sha256, file.size, now());
    if (latest) this.write("UPDATE assets SET version=version+1 WHERE id=?", assetId);
    return versionId;
  }

  importFiles(projectId: unknown, files: { source: string; file: StoredFile }[]) {
    return this.transaction(() => {
      const project = this.project(projectId, true);
      return files.map(({ source, file }) => {
        const sourceKey = source ? keyPath(source) : "attachment:" + file.sha256 + "/" + file.fileName;
        const current = this.get<AssetRow>("SELECT * FROM assets WHERE projectId=? AND sourceKey=? ORDER BY role='user' DESC LIMIT 1", project.id, sourceKey);
        if (current && current.lifecycle !== "active") throw new Error(`请先恢复资产 ${current.name}。`);
        const assetId = current?.id ?? randomUUID();
        if (!current) this.write("INSERT INTO assets(id,projectId,name,role,sourcePath,sourceKey) VALUES (?,?,?,'user',?,?)",
          assetId, project.id, file.fileName, source, sourceKey);
        if (current) this.write("DELETE FROM conversation_owned_assets WHERE assetId=?", assetId);
        return { id: assetId, versionId: this.addVersion(assetId, file) };
      });
    });
  }

  saveAsset(values: Params) {
    return this.transaction(() => {
      const row = this.get<AssetRow>("SELECT * FROM assets WHERE id=?", id(values.id));
      if (!row || row.lifecycle !== "active") throw new Error("请先恢复资产。");
      this.project(row.projectId, true);
      this.assertVersion(row, values.version);
      if (typeof values.context !== "boolean") throw new Error("请选择资产用途。");
      const group = values.groupName === undefined ? row.groupName : text(values.groupName, "资料分组", 60, true);
      this.write("UPDATE assets SET name=?,context=?,groupName=?,version=version+1 WHERE id=?",
        text(values.name, "资产名称", 160), values.context ? 1 : 0, group, row.id);
      return { id: row.id };
    });
  }

  claim(values: Params, next: boolean) {
    return this.transaction(() => this.claimRun(values, next));
  }

  private claimRun(values: Params, next: boolean, refinementInputs?: RefinementInputs, at = Date.now()) {
    const requestKey = id(values.requestKey);
    const choice=sessionChoice(values.sessionChoice);
    const duplicate = this.get<{id:string;taskId:string;projectId:string}>(
      "SELECT id,taskId,projectId FROM runs WHERE requestKey=?", requestKey);
    if (duplicate) {
      if ((next ? duplicate.projectId : duplicate.taskId) !== values.id || JSON.stringify(sessionChoice(this.run(duplicate.id).snapshot.sessionChoice))!==JSON.stringify(choice)) throw new Error("启动请求标识已使用。");
      return { ...duplicate, created: false };
    }
    const taskRow = next ? null : this.taskRow(values.id, true);
    const project = this.project(taskRow?.projectId ?? values.id, true);
    assertSessionChoice(this,project.id,choice);
    const row = taskRow ?? this.get<TaskRow>(`
      SELECT * FROM tasks WHERE projectId=? AND lifecycle='active' AND status='queued' ORDER BY queueRank,createdAt LIMIT 1
    `, project.id);
    this.assertVersion(next ? project : taskRow!, values.version);
    if (!row) throw new Error("此项目的队列为空。");
    const policy=policyFor(this,project.id);
    const window=scheduleWindow(policy,at);
    if(policy.paused||!window.open)throw new Error(policy.paused?"项目派发已暂停。":"当前不在项目执行时段内。");
    if (!(refinementInputs && canRefineStatus(row.status)) && !startableStatuses.includes(row.status)) throw new Error("任务当前无法启动。");
    if (this.get("SELECT id FROM runs WHERE (projectId=? OR rootKey=?) AND status IN ('running','recover')",
      project.id, project.rootKey)) throw new Error("项目或同一目录已有执行中的任务。");
    const task = this.task(row);
    const chosen = new Map<string, InputFile>();
    for (const versionId of task.inputVersionIds) {
      const file = this.version(project.id, versionId);
      chosen.set(file.id, { ...file, role: "input" });
    }
    const inputAssets = new Set([...chosen.values()].map(file => file.assetId));
    for (const file of conversationInputs(this, task.id)) {
      if (inputAssets.has(file.assetId)) continue;
      chosen.set(file.id, file);
      inputAssets.add(file.assetId);
    }
    for (const file of this.all<AssetVersion & { name: string }>(`
      SELECT v.*, a.name FROM assets a JOIN asset_versions v ON v.assetId=a.id
      WHERE a.projectId=? AND a.lifecycle='active' AND a.context=1
        AND v.revision=(SELECT max(revision) FROM asset_versions WHERE assetId=a.id)
    `, project.id)) {
      if (!chosen.has(file.id)) chosen.set(file.id, { ...file, role: "context" });
    }
    if (project.handoffVersionId && !chosen.has(project.handoffVersionId)) {
      const file = this.version(project.id, project.handoffVersionId);
      chosen.set(file.id, { ...file, role: "handoff" });
    }
    const requirements = task.reviews.filter(review => review.decision === "refine").map(review => review.note);
    let refinement: Snapshot["refinement"];
    if (requirements.length) {
      const previous = this.previousDelivery(task.id);
      if (previous) {
        for (const file of this.run(previous.id).files) {
          const input = chosen.get(file.id) ?? { ...this.version(project.id, file.id), role: "previous" as const };
          chosen.set(file.id, { ...input, previousPath: file.path });
        }
      }
      for (const versionId of refinementInputs?.versionIds ?? []) {
        const file = chosen.get(versionId) ?? { ...this.version(project.id, versionId), role: "input" as const };
        chosen.set(versionId, { ...file, refinementAttachment: true });
      }
      refinement = { requirements, previousRunId: previous?.id ?? null, previousSummary: previous?.summary ?? "",
        attachmentFingerprint: refinementInputs?.fingerprint };
    }
    const last=this.get<{id:string;status:RunStatus}>("SELECT id,status FROM runs WHERE taskId=? ORDER BY startedAt DESC,rowid DESC LIMIT 1",task.id);
    const checkpoint = !refinementInputs && last?.status === "paused" ? this.run(last.id) : undefined;
    if(checkpoint){
      const reuseInputs = task.version === checkpoint.snapshot.taskVersion + 2;
      if (reuseInputs) chosen.clear();
      for (const file of checkpoint.snapshot.files) {
        if (reuseInputs || file.refinementAttachment) chosen.set(file.id,file);
      }
      for(const file of checkpoint.files)chosen.set(file.id,{...this.version(project.id,file.id),role:"previous",previousPath:file.path});
    }
    const snapshot: Snapshot = {
      sessionChoice:choice,
      conversationHandoff: handoffFor(this, project.id, task.id),
      taskVersion: task.version, title: task.title, instructions: task.instructions,
      projectTitle: project.title, projectDescription: project.description, projectRoot: project.root,
      permission: project.permission ?? "default", preferredModel: project.preferredModel, preferredEffort: project.preferredEffort,
      expectedFiles: task.expectedFiles, textChecks: task.textChecks, reviewCriteria: task.reviewCriteria,
      files: [...chosen.values()], handoffVersionId: checkpoint?checkpoint.snapshot.handoffVersionId:project.handoffVersionId, refinement,
      checkpoint:checkpoint?{runId:checkpoint.id,summary:checkpoint.summary}:undefined
    };
    const runId = randomUUID();
    this.write(`
      INSERT INTO runs(id,taskId,projectId,rootKey,requestKey,snapshot,workDir,startedAt,deadline,parentRunId) VALUES (?,?,?,?,?,?,?,?,?,?)
    `, runId, task.id, project.id, project.rootKey, requestKey, JSON.stringify(snapshot), join(this.root, "runs", runId),new Date(at).toISOString(),
      policy.mode==="window"?window.next:null,checkpoint?.id??refinement?.previousRunId??null);
    this.write("UPDATE tasks SET status='running',queueRank=NULL,version=version+1,updatedAt=? WHERE id=?", now(), task.id);
    this.event(runId,refinementInputs?"根据补充需求继续优化":values.scheduled?"按项目设置领取任务":"用户手动启动");
    return { id: runId, taskId: task.id, projectId: project.id, created: true };
  }

  toRun(row: RunRow): RunRecord {
    return {
      ...row, checks: JSON.parse(row.checks), snapshot: JSON.parse(row.snapshot),
      route: this.get<NonNullable<Run["route"]>>("SELECT kind,reason FROM run_routes WHERE runId=?",row.id),
      checkpointSafe:Boolean(this.get("SELECT 1 FROM run_checkpoints WHERE runId=? AND safe=1",row.id)),
      approvals:this.all("SELECT id,kind,detail,status,createdAt FROM run_approvals WHERE runId=? ORDER BY createdAt",row.id),
      files: this.all<Run["files"][number]>(`
        SELECT v.*, f.path, f.role FROM run_files f JOIN asset_versions v ON v.id=f.versionId WHERE f.runId=? ORDER BY f.rowid
      `, row.id)
    };
  }

  run(value: unknown) {
    const row = this.get<RunRow>("SELECT * FROM runs WHERE id=?", id(value));
    if (!row) throw new Error("找不到执行记录。");
    return this.toRun(row);
  }

  event(runId: string, message: string) {
    this.write("INSERT INTO run_events(runId,at,message) VALUES (?,?,?)", runId, now(), message);
  }

  recordUsage(runId: string, threadId: string, turnId: string, usage: unknown) {
    if (!usage || typeof usage !== "object" || !("total" in usage) || !usage.total || typeof usage.total !== "object") return;
    const { totalTokens, inputTokens, outputTokens } = usage.total as Params;
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (!valid(totalTokens) || !valid(inputTokens) || !valid(outputTokens)) return;
    // The runner supplies a cumulative reading scoped to this turn.
    this.write(`UPDATE runs SET totalTokens=?,inputTokens=?,outputTokens=?
      WHERE id=? AND threadId=? AND turnId=? AND (totalTokens IS NULL OR totalTokens<=?)`,
      totalTokens, inputTokens, outputTokens, runId, threadId, turnId, totalTokens);
  }

  progress(runId: string, phase: string, threadId?: string, turnId?: string) {
    this.write(`
      UPDATE runs SET phase=?,threadId=coalesce(?,threadId),turnId=coalesce(?,turnId)
      WHERE id=? AND status IN ('running','recover')
    `, phase, threadId ?? null, turnId ?? null, runId);
    this.event(runId, phase);
  }

  requestStop(value: unknown, reason="user", at=Date.now()) {
    return this.transaction(() => {
      const run = this.run(value);
      if (run.status !== "running") throw new Error("当前没有可中断的运行。");
      if (!run.stopRequested) {
        this.write("UPDATE runs SET stopRequested=1,stopReason=?,stopAt=?,phase='等待中断回执' WHERE id=?",reason,at,run.id);
        this.event(run.id, "收到中断请求");
      }
      return { id: run.id };
    });
  }

  pendingRecovery() {
    return this.all<{ id: string }>("SELECT id FROM runs WHERE status IN ('running','recover')").map(run => run.id);
  }

  recover(runId: string, reason: string) {
    if(this.get("SELECT 1 FROM runs WHERE id=? AND status='recover' AND error=?",runId,reason))return;
    this.write("UPDATE runs SET status='recover',phase='待核对',error=? WHERE id=? AND status IN ('running','recover')",
      reason, runId);
    this.event(runId, "需核对运行状态");
  }

  checkpoint(runId:string, delivery:Delivery, at:number) {
    const run=this.run(runId);
    if(!activeStatuses.includes(run.status)||!delivery.files.some(f=>f.role==="handoff")||delivery.checks.some(c=>!c.passed))return;
    if(run.deadline!==null&&at>=run.deadline)return;
    const json=JSON.stringify(delivery);
    this.write(`INSERT INTO run_checkpoints(runId,recordedAt,delivery,safe) VALUES(?,?,?,?)
      ON CONFLICT(runId) DO UPDATE SET recordedAt=excluded.recordedAt,delivery=excluded.delivery,safe=excluded.safe WHERE delivery<>excluded.delivery AND recordedAt<=excluded.recordedAt`,
      runId,at,json,Number(delivery.resumeSafe===true));
  }

  publish(run: RunRecord, output: CollectedFile) {
    const sourceKey = `${run.taskId}/${output.path}`;
    const prior = this.get<AssetRow>("SELECT * FROM assets WHERE projectId=? AND role=? AND sourceKey=? AND lifecycle='active'",
      run.projectId, output.role, sourceKey);
    const assetId = prior?.id ?? randomUUID();
    if (!prior) this.write("INSERT INTO assets(id,projectId,name,role,sourcePath,sourceKey) VALUES (?,?,?,?,?,?)",
      assetId, run.projectId, output.fileName, output.role, output.path, sourceKey);
    const versionId = this.addVersion(assetId, output);
    this.write("INSERT INTO run_files(runId,versionId,path,role) VALUES (?,?,?,?)",
      run.id, versionId, output.path, output.role);
  }

  promoteHandoff(run: RunRecord) {
    const file = this.get<{ versionId: string }>("SELECT versionId FROM run_files WHERE runId=? AND role='handoff' ORDER BY rowid LIMIT 1", run.id);
    if (file) this.write(`
      UPDATE projects SET handoffVersionId=?,version=version+1,updatedAt=?
      WHERE id=? AND handoffVersionId IS ?
    `, file.versionId, now(), run.projectId, run.snapshot.handoffVersionId);
  }

  finish(runId: string, modelStatus: string, delivery: Delivery, detail = "", turnDurationMs?: number | null, completedAt?:number|null) {
    return this.transaction(() => {
      const run = this.run(runId);
      if (!activeStatuses.includes(run.status)) return run;
      const checks: Check[] = [{ label: hostName+" 回合回执", passed: modelStatus === "completed", detail: modelStatus }, ...delivery.checks];
      let status: RunStatus;
      const late=run.deadline!==null && (completedAt??Date.now())>=run.deadline;
      if (modelStatus === "interrupted" || (late && modelStatus==="completed")) status = "paused";
      else if (modelStatus !== "completed" || checks.some(check => !check.passed)) status = "error";
      else status = run.snapshot.refinement || run.snapshot.reviewCriteria || !run.snapshot.expectedFiles.length ? "review" : "done";
      if(status==="paused"){
        const saved=this.get<{delivery:string}>("SELECT delivery FROM run_checkpoints WHERE runId=?",run.id);
        if(saved){
          const checkpoint=JSON.parse(saved.delivery) as Delivery;
          const paths=new Map(delivery.files.map(f=>[f.path,f]));
          for(const file of checkpoint.files)paths.set(file.path,file);
          delivery={...delivery,summary:checkpoint.summary,files:[...paths.values()]};
        }
      }
      for (const output of delivery.files) this.publish(run, output);
      if(late&&!run.stopRequested)this.write("UPDATE runs SET stopRequested=1,stopReason='window',stopAt=? WHERE id=?",run.deadline,runId);
      this.write("UPDATE run_approvals SET status='expired' WHERE runId=? AND status='pending'",runId);
      if(status==="error" && /not authenticated|unauthorized|insufficient_quota|usage.limit|quota exceeded|rate.limit|permission denied|not logged in|未登录|额度不足|沙箱服务不可用|执行环境未能写入隔离目录/i.test(detail)){
        this.write("UPDATE project_policy SET paused=1,reason=?,version=version+1 WHERE projectId=? AND mode<>'manual'",detail.slice(0,500)||"运行环境异常",run.projectId);
      }
      this.write(`
        UPDATE runs SET status=?,phase=?,modelStatus=?,endedAt=?,turnDurationMs=?,summary=?,error=?,checks=? WHERE id=?
      `, status, { error: "执行或核验失败", paused: "已中断", review: "等待人工验收", done: "验收通过" }[status],
        modelStatus, now(), typeof turnDurationMs === "number" && Number.isSafeInteger(turnDurationMs) && turnDurationMs >= 0 ? turnDurationMs : null, delivery.summary,
        detail || (status === "error" ? delivery.checks.find(check => !check.passed)?.detail || "" : ""),
        JSON.stringify(checks), runId);
      this.write("UPDATE tasks SET status=?,version=version+1,updatedAt=? WHERE id=?", status, now(), run.taskId);
      if (status === "done") this.promoteHandoff(run);
      this.event(runId, `回合终态 ${modelStatus} · 任务状态 ${status}`);
      return this.run(runId);
    });
  }

  private controllingRun(task: TaskRow) {
    return this.get<{ id: string; status: RunStatus }>(`
      SELECT id,status FROM runs WHERE taskId=? AND status IN ('running','recover','review')
      ORDER BY status='review',startedAt DESC,rowid DESC LIMIT 1`, task.id);
  }

  scheduleClaims(at=Date.now()) {
    return this.transaction(()=>{
      const started:string[]=[];
      const projects=this.all<ProjectRow>(`SELECT p.* FROM projects p JOIN project_policy x ON x.projectId=p.id
        WHERE p.lifecycle='active' AND x.mode<>'manual' AND x.paused=0 ORDER BY p.createdAt,p.id`);
      for(const project of projects){
        if(!scheduleWindow(policyFor(this,project.id),at).open||this.get("SELECT 1 FROM runs WHERE (projectId=? OR rootKey=?) AND status IN ('running','recover')",project.id,project.rootKey))continue;
        const checkpoint=this.get<TaskRow>(`SELECT t.* FROM tasks t JOIN runs r ON r.taskId=t.id WHERE t.projectId=? AND t.lifecycle='active'
          AND t.status='paused' AND r.id=(SELECT id FROM runs WHERE taskId=t.id ORDER BY startedAt DESC,rowid DESC LIMIT 1)
          AND t.version=json_extract(r.snapshot,'$.taskVersion')+2 AND r.stopReason='window' AND r.modelStatus='interrupted' AND r.deadline<=? AND EXISTS(SELECT 1 FROM run_checkpoints WHERE runId=r.id AND safe=1) ORDER BY r.endedAt LIMIT 1`,project.id,at);
        const queued=this.get("SELECT 1 FROM tasks WHERE projectId=? AND lifecycle='active' AND status='queued'",project.id);
        if(!checkpoint&&!queued)continue;
        const target=checkpoint??project;
        const claimed=this.claimRun({id:target.id,version:target.version,requestKey:randomUUID(),scheduled:true},!checkpoint,undefined,at);
        if(claimed.created)started.push(claimed.id);
      }
      return started;
    });
  }

  private previousDelivery(taskId: string) {
    return this.get<{ id: string; summary: string }>(`
      SELECT id,summary FROM runs WHERE taskId=? AND status IN ('refined','done','returned')
      ORDER BY startedAt DESC,rowid DESC LIMIT 1`, taskId);
  }

  private refinementSource(task: TaskRow, requested?: unknown) {
    if (task.status !== "done") return this.pendingReview(task, requested);
    const previous = this.previousDelivery(task.id);
    if (this.controllingRun(task) || (requested != null && previous?.id !== id(requested))) {
      throw new Error("任务的完成记录已变化，请刷新后再操作。");
    }
    return previous ? this.run(previous.id) : undefined;
  }

  private pendingReview(task: TaskRow, requested?: unknown) {
    const owner = this.controllingRun(task);
    if (task.status !== "review" || (owner && owner.status !== "review") ||
        (requested != null && owner?.id !== id(requested))) throw new Error("任务的待验收记录已变化，请刷新后再操作。");
    return owner ? this.run(owner.id) : undefined;
  }

  private recordReview(task: TaskRow, run: RunRecord | undefined, decision: TaskReview["decision"], note: string, requestKey?: string) {
    this.write("INSERT INTO task_reviews(taskId,runId,decision,note,createdAt,requestKey) VALUES (?,?,?,?,?,?)",
      task.id, run?.id ?? null, decision, note, now(), requestKey ?? null);
  }

  private applyReview(task: TaskRow, run: RunRecord | undefined, decision: "accept" | "return", note: string) {
    const accepted = decision === "accept";
    if (run) {
      const check = { label: accepted ? "人工验收通过" : "人工验收退回", passed: accepted, detail: note };
      this.write("UPDATE runs SET status=?,phase=?,checks=?,reviewNote=? WHERE id=?",
        accepted ? "done" : "returned", check.label, JSON.stringify([...run.checks, check]), note, run.id);
      if (accepted) this.promoteHandoff(run);
      this.event(run.id, check.label);
    }
    this.writeTaskStatus(task, accepted ? "done" : "todo");
    this.recordReview(task, run, decision, note);
  }

  review(values: Params) {
    return this.transaction(() => {
      const task = this.taskRow(values.id ?? this.run(values.runId).taskId, true);
      this.project(task.projectId, true);
      this.assertVersion(task, values.version);
      const run = this.pendingReview(task, values.runId);
      if (values.decision !== "accept" && values.decision !== "return") throw new Error("请选择验收结论。");
      this.applyReview(task, run, values.decision, text(values.note ?? "", "验收记录", 8000, true));
      return { id: run?.id ?? task.id };
    });
  }

  refine(values: Params, attachments: TaskAttachment[] = []) {
    const taskId = id(values.id);
    const requestKey = id(values.requestKey);
    const note = text(values.note, "补充需求", 8000, attachments.length > 0) || "根据本轮补充附件继续优化。";
    const fingerprint = attachments.length
      ? createHash("sha256").update(JSON.stringify(attachmentIdentity(attachments))).digest("hex")
      : undefined;
    return this.transaction(() => {
      const duplicate = this.get<{ id: string; taskId: string; projectId: string; note: string | null; runId: string | null }>(`
        SELECT r.id,r.taskId,r.projectId,h.note,h.runId FROM runs r
        LEFT JOIN task_reviews h ON h.requestKey=r.requestKey WHERE r.requestKey=?`, requestKey);
      if (duplicate) {
        const {snapshot} = this.run(duplicate.id);
        if (duplicate.taskId !== taskId || duplicate.note !== note || snapshot.refinement?.attachmentFingerprint !== fingerprint ||
            JSON.stringify(sessionChoice(snapshot.sessionChoice)) !== JSON.stringify(sessionChoice(values.sessionChoice)) ||
            (values.runId != null && duplicate.runId !== values.runId)) {
          throw new Error("优化请求标识已使用。");
        }
        return { id: duplicate.id, taskId, projectId: duplicate.projectId, created: false };
      }
      const task = this.taskRow(taskId, true);
      this.project(task.projectId, true);
      this.assertVersion(task, values.version);
      const run = this.refinementSource(task, values.runId);
      if (run && task.status === "review") {
        this.write("UPDATE runs SET status='refined',phase='已转入优化',reviewNote=? WHERE id=?", note, run.id);
        this.event(run.id, "收到补充需求，转入下一轮优化");
      }
      this.recordReview(task, run, "refine", note, requestKey);
      const versionIds = attachments.length ? this.importFiles(task.projectId, attachments).map(file => file.versionId) : [];
      return this.claimRun({id:taskId, version:task.version, requestKey, sessionChoice:values.sessionChoice}, false, {versionIds,fingerprint});
    });
  }
}

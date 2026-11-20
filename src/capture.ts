import { fileHistory, retractConversationFiles, retryConversationFiles, syncRunFileEvidence } from "./conversation-files.ts";
import { fingerprint, recognizeWithCodex, type Recognize } from "./semantic.ts";
import { applySemanticJob, captureBoundRequests, nextBoundRequests, enqueueSemantic, nextSemanticJob, retrySemanticJob } from "./semantic-capture.ts";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AppServer, RpcError } from "./app-server.ts";
import { policyFor } from "./schedule.ts";
import type { Store } from "./store.ts";
import type { CapturedState, Params } from "./types.ts";
import { parseSessionId } from "./host-identity.ts";
import { id } from "./validation.ts";

export interface ThreadMeta {
  id: string;
  cwd: string;
  name?: string | null;
  preview?: string;
  updatedAt: number;
  forkedFromId?: string | null;
}
interface Item {
  type: string;
  id: string;
  content?: { type: string; text?: string; path?:string }[];
  phase?:string; status?:string; path?:string; savedPath?:string|null;
  changes?: { path:string; kind:{type:string;move_path?:string|null} }[];
  text?: string;
}
export interface Turn {
  id: string;
  status: string;
  items: Item[];
  completedAt?: number | null;
  startedAt?: number | null;
}
export interface Link {
  threadId: string;
  projectId: string | null;
  taskId: string | null;
  cwd: string;
  name: string;
  summary: string;
  parentId: string | null;
  kind: "auto" | "manual" | "candidate" | "ignored";
  choices: string;
  matchBasis?: "directory" | "semantic";
  matchReason?: string;
  matchQuote?: string;
  seenAt: number;
  version: number;
}
export interface Source {
  threadId: string;
  turnId: string;
  anchor: string;
  evidence?: string;
  recognizedState?: CapturedState | null;
  projectId: string;
  taskId: string | null;
  title: string;
  created: number;
  taskVersion: number | null;
  status: string;
}
export const localThreadId = (value: unknown) => {
  const key=parseSessionId(value);
  if (!key) throw new Error("会话标识无效。");
  return key;
};
const canonical = (s: string) => (process.platform === "win32" ? resolve(s).toLowerCase() : resolve(s));
export function contains(root: string, path: string) {
  const tail = relative(canonical(root), canonical(path));
  return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep));
}
const norm = (s: string) =>
  s
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s，。,.!！]+/gu, "");
const explicitStates: Record<string, CapturedState["status"]> = {
  "[ ]":"todo", "[x]":"done", "待办":"todo", todo:"todo", "已排队":"queued", "队列":"queued", queued:"queued",
  "进行中":"running", "in progress":"running", "待验收":"review", "in review":"review", "已完成":"done", done:"done",
  "错误":"error", failed:"error", "已暂停":"paused", paused:"paused"
};
export function actionLines(message: string) {
  const lines: { title: string; anchor: string; description: string; taskId?: string; state?: CapturedState["status"]; quote: string }[] = [];
  let fence = false;
  for (const [index, raw] of message.split(/\r?\n/).entries()) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence || /^\s*[><]/.test(raw)) continue;
    const line = raw.trim().replace(/^(?:[-*]\s*|\d+[.、)）]\s*)/, "");
    const marker = /^(\[ \]|\[x\])\s*|^(待办|TODO|行动项|下一步|已排队|队列|queued|进行中|in progress|待验收|in review|已完成|done|错误|failed|已暂停|paused)[：:]\s*/i.exec(line);
    const body = line.slice(marker?.[0].length ?? 0).trim();
    if (
      !body ||
      /[?？]$/.test(body) ||
      (!marker &&
        !/^(?:请(?:帮我)?|帮我)?(?:新增|添加|增加|实现|支持|修复|优化|完成|整理|更新|创建|检查|补充|设计|验证|移除|替换|调整|编写|导入|提交|构建|implement\b|fix\b|add\b|create\b|update\b|verify\b|write\b|build\b)/i.test(
          body,
        ))
    )
      continue;
    const taskId = body.match(/\[task:([0-9a-f-]{36})\]/i)?.[1];
    lines.push({ title: body.slice(0, 160), description: body.slice(0, 8000), anchor: String(index), taskId,
      state: marker ? explicitStates[(marker[1] ?? marker[2]).toLowerCase()] : undefined, quote:line.slice(0,500) });
  }
  return lines;
}
export interface CapturedRef {
  threadId: string;
  turnId: string;
  versionId: string;
  path: string;
  revision: number;
}
export function collectRefs(db: Store, link: Link, turnId: string, body: string) {
  const references = [...body.matchAll(/\]\((?:<([^>]+)>|([^()\s]+))\)|`([^`\r\n]+)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((path) => path.length < 1024);
  if (!references.length) return;
  const registered = db.all<{ versionId: string; path: string }>(
    `SELECT v.id versionId,a.sourcePath path FROM assets a JOIN asset_versions v ON a.id=v.assetId
    WHERE a.projectId=? AND a.lifecycle='active' AND a.role='user' AND v.revision=(SELECT max(revision) FROM asset_versions WHERE assetId=a.id)
    UNION ALL SELECT f.versionId,r.workDir||'/outputs/'||f.path FROM runs r JOIN run_files f ON r.id=f.runId WHERE r.projectId=?`,
    link.projectId,
    link.projectId,
  );
  const cwd = resolve(link.cwd);
  let physicalCwd = cwd;
  if (process.platform === "win32" && /~\d/.test(cwd)) {
    // Codex may report an 8.3 working directory while imported assets use the long path.
    try { physicalCwd = realpathSync.native(cwd); } catch { /* The source directory may be offline. */ }
  }
  const pathKey = (path: string) => canonical(physicalCwd !== cwd && contains(cwd, path)
    ? resolve(physicalCwd, relative(cwd, path)) : path);
  const byPath = new Map<string, typeof registered[number]>();
  for (const asset of registered) {
    const key = pathKey(asset.path);
    if (!byPath.has(key)) byPath.set(key, asset);
  }
  for (const raw of references) {
    let path = raw;
    try {
      path = decodeURIComponent(raw);
    } catch {
      continue;
    }
    const known = byPath.get(pathKey(resolve(cwd, path)));
    if (known)
      db.write(
        "INSERT OR IGNORE INTO capture_refs(threadId,turnId,projectId,versionId,path) VALUES(?,?,?,?,?)",
        link.threadId,
        turnId,
        link.projectId,
        known.versionId,
        path,
      );
  }
}
export function sessionState(db: Store, projectId: string) {
  const rows = db.all<Link & { candidateReason: string | null }>(
    `SELECT l.*, e.reason candidateReason, e.quote matchQuote FROM thread_links l
     LEFT JOIN thread_match_evidence e ON e.threadId=l.threadId AND e.projectId=?
     WHERE l.projectId=? OR EXISTS (SELECT 1 FROM json_each(l.choices) WHERE value=?) ORDER BY l.name,l.threadId`,
    projectId, projectId, projectId);
  const links = rows.map(({ candidateReason, ...link }) => ({ ...link, matchReason: candidateReason ?? link.matchReason }));
  const sources = db.all<Source & {stateProof:string|null}>("SELECT * FROM capture_items WHERE projectId=? ORDER BY rowid DESC", projectId)
    .map(({stateProof,...source}) => ({...source, recognizedState:stateProof ? JSON.parse(stateProof) as CapturedState : null}));
  const refs = db.all<CapturedRef>(
    "SELECT r.*,v.revision FROM capture_refs r JOIN asset_versions v ON v.id=r.versionId WHERE r.projectId=?",
    projectId,
  );
  return { links, sources, refs, files:fileHistory(db,projectId) };
}
export function scopes(db: Store) {
  return db.all<{ id: string; root: string; title: string; description: string; semanticScope: "off" | "roots" | "all" }>(
    "SELECT p.id,p.root,p.title,p.description,x.semanticScope FROM projects p JOIN project_policy x ON x.projectId=p.id WHERE p.lifecycle='active' AND x.capture=1 ORDER BY p.id"
  ).map(p => ({ ...p, paths: [p.root, ...policyFor(db, p.id).roots] }));
}
export function authorized(db: Store, link: Link) {
  const owners = scopes(db);
  if (link.kind === "manual") return owners.some(p => p.id === link.projectId);
  const matching = owners.filter(p => p.paths.some(path => contains(path, link.cwd)));
  if (link.kind === "auto" && link.matchBasis === "semantic") return owners.some(p => p.id === link.projectId &&
    (p.semanticScope === "all" || (p.semanticScope === "roots" && matching.includes(p))));
  return link.kind === "auto" && matching.length === 1 && matching[0].id === link.projectId;
}
export function existing(db: Store, threadId: string) {
  return db.get<Link>("SELECT * FROM thread_links WHERE threadId=?", threadId);
}
function retract(db: Store, link: Link) {
  db.write("DELETE FROM conversation_updates WHERE threadId=? AND runId IS NULL", link.threadId);
  db.write("DELETE FROM capture_refs WHERE threadId=?", link.threadId);
  retractConversationFiles(db, link.threadId);
  for (const item of db.all<Source & {stateProof:string|null}>(
    "SELECT * FROM capture_items WHERE threadId=? AND status='active'",
    link.threadId,
  )) {
    if (!item.taskId || !item.created) continue;
    const task = db.taskRow(item.taskId);
    const shared = db.get<{ rowid: number }>(
      "SELECT rowid FROM capture_items WHERE taskId=? AND threadId<>? AND status='active' ORDER BY rowid LIMIT 1",
      task.id,
      link.threadId,
    );
    if (shared)
      db.write("UPDATE capture_items SET created=1,taskVersion=? WHERE rowid=?", item.taskVersion, shared.rowid);
    if (
      !shared &&
      task.version === item.taskVersion &&
      (task.status === "todo" || !!item.evidence || !!item.stateProof) &&
      task.lifecycle === "active" &&
      !db.get("SELECT 1 FROM runs WHERE taskId=?", task.id)
    )
      db.write(
        "UPDATE tasks SET lifecycle='trash',version=version+1,updatedAt=? WHERE id=?",
        new Date().toISOString(),
        task.id,
      );
  }
  db.write("UPDATE capture_items SET status='withdrawn' WHERE threadId=?", link.threadId);
}
export function changeLink(db: Store, p: Params, meta?: ThreadMeta) {
  return db.transaction(() => {
    const project = db.project(p.projectId, true),
      tid = localThreadId(p.threadId);
    const link = existing(db, tid);
    if ((link?.version ?? 0) !== (p.version ?? 0)) throw new Error("会话归属已更新，请刷新。");
    if (link && link.projectId !== project.id && !JSON.parse(link.choices).includes(project.id))
      throw new Error("请从会话当前所属项目改归属。");
    db.write("DELETE FROM semantic_jobs WHERE threadId=?", tid);
    db.write("DELETE FROM thread_match_evidence WHERE threadId=?", tid);
    if (p.operation === "ignore" || p.operation === "undo") {
      if (!link) throw new Error("会话尚未绑定。");
      retract(db, link);
      db.write("UPDATE thread_links SET kind='ignored',version=version+1,seenAt=-1 WHERE threadId=?", tid);
      return;
    }
    const target = db.project(p.targetProjectId ?? project.id, true);
    const task = p.taskId ? db.taskRow(p.taskId, true) : null;
    if (task && task.projectId !== target.id) throw new Error("请选择目标项目的任务。");
    if (!link && !meta) throw new Error("找不到本地会话。");
    if (link && (link.projectId !== target.id || link.taskId !== (task?.id ?? null))) retract(db, link);
    db.write(
      `INSERT INTO thread_links(threadId,projectId,taskId,cwd,name,summary,parentId,kind) VALUES(?,?,?,?,?,?,?,'manual')
      ON CONFLICT(threadId) DO UPDATE SET projectId=excluded.projectId,taskId=excluded.taskId,kind='manual',choices='[]',matchReason='',seenAt=-1,version=version+1`,
      tid,
      target.id,
      task?.id ?? null,
      link?.cwd ?? meta!.cwd,
      link?.name ?? meta?.name ?? tid,
      link?.summary ?? meta?.preview?.slice(0, 360) ?? "",
      link?.parentId ?? meta?.forkedFromId ?? null,
    );
  });
}
export function matchThread(db: Store, m: ThreadMeta) {
  const prev = existing(db, m.id);
  if (prev?.kind === "ignored" || prev?.kind === "manual" || (prev?.matchBasis === "semantic" && prev.kind === "auto")) return prev;
  const choices = scopes(db)
    .filter((p) => p.paths.some((path) => contains(path, m.cwd)))
    .map((p) => p.id)
    .sort();
  if (!choices.length) return;
  const owner = choices.length === 1 ? choices[0] : null,
    kind = owner ? "auto" : "candidate";
  if (prev && prev.matchBasis !== "semantic" && prev.projectId === owner && prev.choices === JSON.stringify(choices)) return prev;
  db.transaction(() => {
    if (prev && prev.projectId !== owner) retract(db, prev);
    if (prev) db.write("DELETE FROM thread_match_evidence WHERE threadId=?", m.id);
    db.write(
      `INSERT INTO thread_links(threadId,projectId,cwd,name,summary,parentId,kind,choices) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(threadId) DO UPDATE SET projectId=excluded.projectId,kind=excluded.kind,choices=excluded.choices,matchBasis='directory',matchReason='',summary=excluded.summary,cwd=excluded.cwd,name=excluded.name,seenAt=-1,version=version+1`,
      m.id,
      owner,
      m.cwd,
      m.name || m.id,
      owner ? (m.preview ?? "").slice(0, 360) : "",
      m.forkedFromId ?? null,
      kind,
      JSON.stringify(choices),
    );
  });
  return existing(db, m.id);
}
export function recordAction(db: Store, link: Link, turnId: string, anchor: string, title: string, description: string, suggested?: string | null, evidence = "", state?: CapturedState) {
  const projectId = link.projectId;
  if (!projectId) return;
  const prior = db.get<Source>("SELECT * FROM capture_items WHERE threadId=? AND turnId=? AND anchor=?", link.threadId, turnId, anchor);
  if (prior?.status === "active") return prior.taskId ? {id:prior.taskId,created:false} : undefined;
  const preferred = link.taskId ?? suggested;
  const known = (preferred ? db.get<{ id: string }>("SELECT id FROM tasks WHERE id=? AND projectId=? AND lifecycle='active'", preferred, projectId) : undefined)
    ?? db.all<{ id: string; title: string }>("SELECT id,title FROM tasks WHERE projectId=? AND lifecycle='active'", projectId).find(t => norm(t.title) === norm(title));
  const taskId = known?.id ?? db.createCapturedTask(projectId, title, description, state?.status);
  db.write(
    `INSERT INTO capture_items(threadId,turnId,anchor,projectId,taskId,title,created,taskVersion,status,evidence) VALUES(?,?,?,?,?,?,?,?,'active',?)
     ON CONFLICT(threadId,turnId,anchor) DO UPDATE SET projectId=excluded.projectId,taskId=excluded.taskId,title=excluded.title,
     created=excluded.created,taskVersion=excluded.taskVersion,status='active',evidence=excluded.evidence,stateProof=NULL`,
    link.threadId, turnId, anchor, projectId, taskId, title, known ? 0 : 1, db.taskRow(taskId).version, evidence);
  return {id:taskId,created:!known};
}
export function ingestTurns(db: Store, link: Link, turns: Turn[], updatedAt: number, summary: string) {
  return db.transaction(() => {
    const live = existing(db, link.threadId);
    if (!live?.projectId || live.version !== link.version || !authorized(db, live)) return;
    for (const turn of turns) {
      for (const [itemIndex, item] of (turn.items ?? []).entries()) {
        if (item.type === "agentMessage" && item.text) collectRefs(db, live, turn.id, item.text);
        if (item.type !== "userMessage") continue;
        const body = (item.content ?? [])
          .filter((x) => x.type === "text")
          .map((x) => x.text ?? "")
          .join("\n");
        if (/^\s*<(?:environment_context|system|instructions|permissions)/i.test(body)) continue;
        collectRefs(db, live, turn.id, body);
        for (const line of actionLines(body)) {
          const anchor = item.id + "/" + line.anchor;
          const proof: CapturedState | undefined = line.state ? {status:line.state,quote:line.quote,author:"user",
            turnId:turn.id,itemId:item.id,itemIndex,offset:Number(line.anchor),at:turn.completedAt ?? turn.startedAt ?? updatedAt} : undefined;
          const captured = recordAction(db, live, turn.id, anchor, line.title, line.description, line.taskId, proof?.quote, proof);
          if (captured && proof) db.applyCapturedState(live.projectId,live.threadId,captured.id,proof);
        }
      }
    }
    const reply = turns
      .flatMap((t) => t.items ?? [])
      .filter((i) => i.type === "agentMessage" && i.text?.trim())
      .at(-1);
    const excerpt = reply?.text?.trim() || summary || live.summary;
    db.write(
      "UPDATE thread_links SET seenAt=max(seenAt,?),summary=? WHERE threadId=?",
      updatedAt,
      excerpt.slice(0, 360),
      live.threadId,
    );
  });
}

export type Reader = Pick<AppServer, "initialize" | "call" | "close">;

export async function readTurns(rpc: Reader, threadId: string, since: number, valid: () => boolean, withContext = false) {
  const turns: Turn[] = [];
  let cursor: string | null = null;
  do {
    if (!valid()) return [];
    try {
      const page: { data: Turn[]; nextCursor: string | null } = await rpc.call("thread/turns/list", {
        threadId, sortDirection: "desc", itemsView: "full", limit: 10, cursor,
      });
      turns.push(...page.data.filter(t => !t.completedAt || t.completedAt >= since - 1));
      const previous = page.data.find(t => t.completedAt && t.completedAt < since - 1);
      if (withContext && previous) turns.push(previous);
      cursor = previous ? null : page.nextCursor;
    } catch (e) {
      if (!(e instanceof RpcError) || ![-32601, -32600].includes(e.code)) throw e;
      const { thread } = await rpc.call<{ thread: { turns: Turn[] } }>("thread/read", { threadId, includeTurns: true });
      const recent = thread.turns.filter(t => !t.completedAt || t.completedAt >= since - 1);
      const previous = withContext && thread.turns.findLast(t => t.completedAt && t.completedAt < since - 1);
      return previous ? [previous, ...recent] : recent;
    }
  } while (cursor);
  return turns.reverse();
}

export class CaptureService {
  private scanning?: Promise<void>;
  private working?: Promise<void>;
  private recent?: Promise<void>;
  private open: (cwd: string) => Promise<Reader>;
  private recognize: Recognize;
  lastError = "";
  private db: Store;
  private cwd: string;
  constructor(db: Store, cwd: string, open: (cwd: string) => Promise<Reader> = AppServer.open, recognize: Recognize = recognizeWithCodex) {
    this.open = open;
    this.recognize = recognize;
    this.db = db;
    this.cwd = cwd;
  }
  async bind(p: Params) {
    const tid = localThreadId(p.threadId);
    this.db.project(p.projectId, true);
    if (existing(this.db, tid)) {
      changeLink(this.db, p);
      this.afterBind(tid);
      return;
    }
    if (p.operation === "ignore" || p.operation === "undo") throw new Error("会话尚未绑定。");
    const rpc = await this.open(this.cwd);
    try {
      await rpc.initialize();
      const { thread } = await rpc.call<{ thread: ThreadMeta }>("thread/read", { threadId: tid, includeTurns: false });
      if (thread.id !== tid) throw new Error("会话标识不一致。");
      changeLink(this.db, p, thread);
      this.afterBind(tid, thread);
    } finally {
      rpc.close();
    }
  }
  private afterBind(tid: string, meta?: ThreadMeta) {
    const link = existing(this.db, tid);
    if (link?.kind !== "manual") return;
    if (enqueueSemantic(this.db, meta ?? { id: tid, cwd: link.cwd, name: link.name, updatedAt: Math.floor(Date.now() / 1000) }))
      void this.processPending().catch(e => { this.lastError = String(e); });
  }
  processPending() {
    if (!this.working) this.working = this.drain().finally(() => { this.working = undefined; });
    if (!this.recent) {
      const job=nextBoundRequests(this.db);
      if (job) this.recent=this.captureRecent(job).finally(()=>{ this.recent=undefined; });
    }
    return Promise.all([this.working,this.recent]).then(()=>{});
  }
  private async captureRecent(job: NonNullable<ReturnType<typeof nextBoundRequests>>) {
    let rpc:Reader | undefined;
    try {
      rpc=await this.open(this.cwd);
      await rpc.initialize();
      await captureBoundRequests(this.db,job,rpc,this.recognize);
    } catch (e) {
      this.lastError=String(e instanceof Error ? e.message : e);
      this.db.write(`INSERT OR REPLACE INTO semantic_receipts(threadId,digest,result)
        SELECT threadId,'requests:retry',? FROM semantic_jobs WHERE threadId=? AND scope=?`,String(Date.now()+60000),job.threadId,job.scope);
    } finally { rpc?.close(); }
  }
  private async drain() {
    await retryConversationFiles(this.db);
    let job = nextSemanticJob(this.db);
    if (!job) return;
    let rpc: Reader | undefined;
    try {
      rpc = await this.open(this.cwd);
      await rpc.initialize();
      while (job) {
        try { await applySemanticJob(this.db, job, rpc, this.recognize); }
        catch (e) { retrySemanticJob(this.db, job, e); }
        job = nextSemanticJob(this.db);
      }
    } catch (e) {
      if (job) retrySemanticJob(this.db, job, e);
    } finally { rpc?.close(); }
  }
  async idle() { await this.scanning?.catch(()=>{}); await Promise.allSettled([this.working,this.recent]); }
  scan() {
    if (!this.scanning)
      this.scanning = this.read()
        .then(() => {
          this.lastError = "";
          void this.processPending().catch(e => { this.lastError = String(e); });
        })
        .catch((e) => {
          this.lastError = String(e instanceof Error ? e.message : e);
          throw e;
        })
        .finally(() => {
          this.scanning = undefined;
        });
    return this.scanning;
  }
  private async read() {
    const allowed = scopes(this.db);
    if (!allowed.length) return;
    syncRunFileEvidence(this.db);
    const rpc = await this.open(this.cwd);
    try {
      await rpc.initialize();
      const paths = [...new Set(allowed.flatMap((p) => p.paths))].sort();
      const semantic = allowed.some(p => p.semanticScope !== "off");
      const catalog = allowed.map(p => [p.id, p.paths, p.semanticScope, p.title, p.description]);
      const scope = fingerprint(catalog);
      const mark = this.db.get<{ cursor: string | null; watermark: number; high: number }>(
        "SELECT * FROM capture_cursors WHERE scope=?",
        scope,
      );
      const page = await rpc.call<{ data: ThreadMeta[]; nextCursor: string | null }>("thread/list", {
        ...(semantic ? { currentAccountOnly: true } : { cwd: paths }),
        sourceKinds: ["cli", "vscode", "appServer", "exec"],
        limit: 30,
        sortKey: "updated_at",
        sortDirection: "desc",
        cursor: mark?.cursor ?? null,
      });
      const metas = new Map(page.data.map((m) => [m.id, m]));
      const boundLinks=this.db.all<Link>(`SELECT l.* FROM thread_links l WHERE l.kind='manual' OR
        (l.kind='auto' AND NOT EXISTS(SELECT 1 FROM semantic_jobs j WHERE j.threadId=l.threadId) AND
         EXISTS(SELECT 1 FROM project_policy x WHERE x.projectId=l.projectId AND x.capture=1 AND x.semanticScope<>'off'))`);
      for (const link of boundLinks) {
        if (!authorized(this.db, link) || metas.has(link.threadId)) continue;
        try {
          const { thread } = await rpc.call<{ thread: ThreadMeta }>("thread/read", {
            threadId: link.threadId,
            includeTurns: false,
          });
          metas.set(thread.id, thread);
        } catch (e) {
          if (!(e instanceof RpcError)) throw e;
        }
      }
      if (semantic) {
        const finished=this.db.all<{threadId:string; ended:number}>(`SELECT r.threadId,max(unixepoch(r.endedAt)) ended
          FROM runs r JOIN projects p ON p.id=r.projectId JOIN project_policy x ON x.projectId=p.id
          LEFT JOIN semantic_jobs j ON j.threadId=r.threadId
          WHERE p.lifecycle='active' AND x.capture=1 AND x.semanticScope<>'off' AND r.threadId IS NOT NULL AND r.endedAt IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM thread_links l WHERE l.threadId=r.threadId AND l.kind='ignored')
          GROUP BY r.threadId HAVING j.wanted IS NULL OR j.wanted<ended ORDER BY ended DESC LIMIT 30`);
        for (const {threadId,ended} of finished) {
          const found=metas.get(threadId);
          if (found) metas.set(threadId,{...found,updatedAt:Math.max(found.updatedAt,ended)});
          else {
            try {
              const {thread}=await rpc.call<{thread:ThreadMeta}>("thread/read",{threadId,includeTurns:false});
              if (thread.id===threadId) metas.set(threadId,{...thread,updatedAt:Math.max(thread.updatedAt,ended)});
            } catch(e) { if (!(e instanceof RpcError)) throw e; }
          }
        }
      }
      for (const meta of metas.values()) {
        if (enqueueSemantic(this.db, meta)) continue;
        if (this.db.get("SELECT 1 FROM runs WHERE threadId=?", meta.id)) continue;
        const link = matchThread(this.db, meta);
        if (!link?.projectId || link.kind === "ignored" || !scopes(this.db).some((p) => p.id === link.projectId))
          continue;
        if (link.seenAt >= meta.updatedAt && meta.updatedAt < Math.floor(Date.now() / 1000) - 60) continue;
        if (link.matchBasis === "semantic" && link.kind !== "manual") continue;
        const turns = await readTurns(rpc, link.threadId, link.seenAt, () => {
          const live = existing(this.db, link.threadId);
          return !!live && live.version === link.version && authorized(this.db, live);
        });
        ingestTurns(this.db, link, turns, meta.updatedAt, meta.preview ?? "");
      }
      const high = Math.max(mark?.high ?? 0, ...page.data.map((m) => m.updatedAt));
      const more =
        page.nextCursor && (!mark?.watermark || page.data.every((m) => m.updatedAt >= mark.watermark - 1))
          ? page.nextCursor
          : null;
      this.db.write(
        "INSERT OR REPLACE INTO capture_cursors(scope,cursor,watermark,high) VALUES(?,?,?,?)",
        scope,
        more,
        more ? (mark?.watermark ?? 0) : high,
        more ? high : 0,
      );
    } finally {
      rpc.close();
    }
  }
}

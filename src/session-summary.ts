import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { RpcError } from "./app-server.ts";
import { contains, existing, localThreadId, type Reader, type Turn } from "./capture.ts";
import { internalFile, localName } from "./conversation-files.ts";
import { policyFor } from "./schedule.ts";
import type { Store } from "./store.ts";
import type { Params } from "./types.ts";
import { localPath, text } from "./validation.ts";

function owner(db: Store, p: Params) {
  const project = db.project(p.projectId), threadId = localThreadId(p.threadId);
  const link = existing(db, threadId);
  const bound = link?.projectId === project.id && (link.kind === "auto" || link.kind === "manual") ? link : undefined;
  const run = db.get<{ workDir: string }>("SELECT workDir FROM runs WHERE projectId=? AND threadId=? ORDER BY startedAt DESC LIMIT 1", project.id, threadId);
  if (!bound && !run) throw Error("此会话不属于当前项目。");
  return { project, threadId, bound, cwd: bound?.cwd || run?.workDir || project.root };
}

export async function completeSummary(db: Store, p: Params, open: () => Promise<Reader>) {
  const { threadId, bound } = owner(db, p);
  const excerpt = bound?.summary ?? "";
  if (excerpt.length !== 360) return { text: excerpt, truncated: false };
  const fallback = { text: excerpt, truncated: true };
  let rpc: Reader | undefined, full: string | undefined;
  try {
    rpc = await open();
    await rpc.initialize();
    const match = (turns: Turn[]) => turns.flatMap(t => (t.items ?? []).filter(i => i.type === "agentMessage").reverse())
      .map(i => i.text?.trim()).find(body => body?.startsWith(excerpt));
    let cursor: string | null = null;
    for (let page = 0; page < 3 && !full; page++) {
      try {
        const batch: { data: Turn[]; nextCursor: string | null } = await rpc.call("thread/turns/list",
          { threadId, sortDirection: "desc", itemsView: "full", limit: 4, cursor });
        full = match(batch.data);
        cursor = batch.nextCursor;
        if (!cursor) break;
      } catch (e) {
        if (!(e instanceof RpcError) || ![-32600, -32601].includes(e.code)) throw e;
        const { thread } = await rpc.call<{ thread: { id: string; turns: Turn[] } }>("thread/read", { threadId, includeTurns: true });
        if (thread.id === threadId) full = match(thread.turns.slice(-12).reverse());
        break;
      }
    }
  } catch { /* The locally saved excerpt remains available offline. */ }
  finally { rpc?.close(); }
  const current = owner(db, p).bound?.summary;
  if (current !== excerpt) return { text: current ?? "", truncated: current?.length === 360 };
  return full ? { text: full.slice(0, 32768), truncated: full.length > 32768 } : fallback;
}

export async function summaryFile(db: Store, p: Params): Promise<{ path: string } | { versionId: string }> {
  const { project, threadId, cwd } = owner(db, p);
  const raw = localName(text(p.href, "文件链接", 2048));
  const target = localPath(resolve(cwd, raw));
  const records = db.all<{ path: string; cwd: string; versionId: string }>(
    `SELECT path,cwd,versionId FROM conversation_files WHERE projectId=? AND threadId=? AND versionId IS NOT NULL ORDER BY occurredAt DESC,rowid DESC`,
    project.id, threadId);
  records.push(...db.all<typeof records[number]>("SELECT path,? cwd,versionId FROM capture_refs WHERE projectId=? AND threadId=? ORDER BY rowid DESC", cwd, project.id, threadId));
  for (const row of records) {
    let path: string;
    try { path = resolve(row.cwd, localName(row.path)); } catch { continue; }
    if (samePath(path, target)) return { versionId: row.versionId };
  }
  const registered = db.all<{path: string; versionId: string}>(`SELECT a.sourcePath path, v.id versionId FROM assets a JOIN asset_versions v ON v.assetId=a.id
    WHERE a.projectId=? AND a.lifecycle<>'trash' AND a.role='user' AND v.revision=(SELECT max(revision) FROM asset_versions WHERE assetId=a.id)`, project.id)
    .find(row => isAbsolute(row.path) && samePath(resolve(row.path), target));
  if (registered) return { versionId: registered.versionId };
  const roots = [project.root, ...policyFor(db, project.id).roots];
  const physical = await realpath(target).catch(() => null);
  const allowed = await Promise.all(roots.map(root => realpath(root).catch(() => null)));
  if (!physical || internalFile(db, physical) || !allowed.some(root => root && contains(root, physical)) || !(await stat(physical)).isFile())
    throw Error("无法预览此文件，请核对文件路径和项目授权目录。");
  owner(db, p);
  return { path: physical };
}

function samePath(a: string, b: string) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Files, type StoredFile } from "./assets.ts";
import { authorized, contains, existing, scopes } from "./capture.ts";
import type { FileOrigin } from "./conversation-file-hints.ts";
import { fingerprint } from "./semantic.ts";
import type { Store } from "./store.ts";
import type { ConversationFile, InputFile, Snapshot } from "./types.ts";
import { localPath } from "./validation.ts";

export const conversationFileSchema = `
  CREATE TABLE conversation_files(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),
    threadId TEXT NOT NULL,turnId TEXT NOT NULL,itemId TEXT NOT NULL,taskId TEXT REFERENCES tasks(id),runId TEXT REFERENCES runs(id),
    role TEXT NOT NULL CHECK(role IN ('material','output')),path TEXT NOT NULL,quote TEXT NOT NULL,origin TEXT NOT NULL,
    cwd TEXT NOT NULL,occurredAt INTEGER NOT NULL,versionId TEXT REFERENCES asset_versions(id),issue TEXT NOT NULL DEFAULT '',
    retryAt INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX conversation_file_project ON conversation_files(projectId,threadId);
  CREATE INDEX conversation_file_task ON conversation_files(taskId,role,occurredAt);
  CREATE INDEX conversation_file_pending ON conversation_files(retryAt) WHERE versionId IS NULL;
  CREATE TABLE conversation_owned_assets(assetId TEXT PRIMARY KEY REFERENCES assets(id),ownedVersion INTEGER NOT NULL,withdrawn INTEGER NOT NULL DEFAULT 0);
  INSERT INTO semantic_receipts(threadId,digest,result)
    SELECT threadId,'files:backfill-through',CAST(processed AS TEXT) FROM semantic_jobs WHERE processed>=0 AND threadId IN (
    SELECT l.threadId FROM thread_links l JOIN project_policy x ON x.projectId=l.projectId WHERE
      l.kind IN ('manual','auto') AND x.capture=1 AND x.semanticScope<>'off'
    UNION SELECT r.threadId FROM runs r JOIN project_policy x ON x.projectId=r.projectId WHERE x.capture=1 AND x.semanticScope<>'off');
  UPDATE semantic_jobs SET processed=-1,failures=0,error='',retryAt=0 WHERE threadId IN
    (SELECT threadId FROM semantic_receipts WHERE digest='files:backfill-through');
  PRAGMA user_version=12;`;

export interface FileEvidence {
  projectId:string; threadId:string; turnId:string; itemId:string; cwd:string; runId:string|null; occurredAt:number;
  role:"material"|"output"; path:string; quote:string; origin:FileOrigin | "runInput" | "runOutput";
}
type Located = {versionId:string} | {source:string;file:StoredFile} | {issue:string};
type Registered = {assetId:string;versionId:string;path:string;pinned?:number};
type Access = {id:string;paths:string[];semanticScope:string};
export interface PreparedFile { evidence:FileEvidence; taskKey:string|null; located:Located }
const key=(path:string)=>process.platform==="win32" ? path.toLowerCase() : path;

export function localName(raw:string) {
  let path=raw.trim().replace(/^<(.+)>$/,"$1");
  if (/^file:\/\//i.test(path)) {
    const url=new URL(path);
    if (url.hostname && url.hostname!=="localhost") throw Error("仅有远程地址");
    path=fileURLToPath(url);
  } else {
    if (/^[a-z][\w+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) throw Error("仅有远程地址或非本地引用");
    if (/%[0-9a-f]{2}/i.test(path)) {try{path=decodeURIComponent(path);}catch{/* A literal percent is valid in a file name. */}}
  }
  path=path.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$|:\d+(?::\d+)?$/i,"");
  if (process.platform==="win32") path=path.replace(/^\/([a-z]:[\\/])/i,"$1");
  if (!path || /[\x00-\x1f*?<>|]/.test(path) || /^[\\/]{2}/.test(path) ||
      (process.platform==="win32" && path.replace(/^[a-z]:[\\/]/i,"").includes(":"))) throw Error("缺少可读取的本地文件路径");
  return path;
}

function registeredFiles(db:Store, e:FileEvidence) {
  const list=db.all<Registered>(`SELECT a.id assetId,v.id versionId,a.sourcePath path,0 pinned FROM assets a
    JOIN asset_versions v ON v.assetId=a.id WHERE a.projectId=? AND a.lifecycle='active'
    AND v.revision=(SELECT max(revision) FROM asset_versions WHERE assetId=a.id)
    UNION ALL SELECT v.assetId,f.versionId,r.workDir||'/outputs/'||f.path,1 FROM run_files f JOIN runs r ON r.id=f.runId
    JOIN asset_versions v ON v.id=f.versionId JOIN assets a ON a.id=v.assetId WHERE r.projectId=? AND a.lifecycle='active'`,e.projectId,e.projectId);
  type RunLocation={workDir:string;snapshot:string;endedAt:string|null};
  const run=e.runId ? db.get<RunLocation>("SELECT workDir,snapshot,endedAt FROM runs WHERE id=? AND projectId=?",e.runId,e.projectId)
    : db.all<RunLocation>("SELECT workDir,snapshot,endedAt FROM runs WHERE threadId=? AND projectId=?",e.threadId,e.projectId)
      .find(r=>key(resolve(r.workDir))===key(resolve(e.cwd)));
  if (run) {
    for (const [i,f] of (JSON.parse(run.snapshot) as Snapshot).files.entries()) {
      list.push({assetId:f.assetId,versionId:f.id,path:join(run.workDir,"inputs",String(i+1).padStart(2,"0")+"-"+f.fileName),pinned:1});
    }
  }
  return {list,run};
}

export function internalFile(db:Store,path:string) {
  if (!contains(db.root,path)) return false;
  const first=relative(db.root,path).split(/[\\/]/)[0].toLowerCase();
  return /^(?:ipc-key|taskboard\.sqlite(?:-.*)?|service\.log|blobs|runs|previews|edits)$/.test(first);
}

export async function locateFile(db:Store,e:FileEvidence,scope:Access):Promise<Located> {
  const recorded=db.get<{versionId:string}>(`SELECT versionId FROM conversation_files WHERE projectId=? AND threadId=? AND turnId=?
    AND itemId=? AND role=? AND path=? AND versionId IS NOT NULL LIMIT 1`,e.projectId,e.threadId,e.turnId,e.itemId,e.role,e.path);
  if(recorded) return recorded;
  try {
    const path=localName(e.path),{list,run}=registeredFiles(db,e);
    const cwd=run?.workDir || e.cwd;
    const bases=[...new Set([cwd,...scope.paths].filter(Boolean).map(p=>resolve(p)))];
    const paths=isAbsolute(path)?[localPath(path)]:bases.map(base=>localPath(resolve(base,path)));
    const physicalRoots=await Promise.all(bases.map(p=>realpath(p).catch(()=>p)));
    const direct=e.origin==="attachment" || e.origin==="generated" || e.origin==="written";
    const candidates=new Map<string,string>(),known=new Map<string,string>();
    let outside=false, awaitingRun=false, directory=false;
    function privatePath(candidate:string) {
      if (!run || !contains(run.workDir,candidate)) return internalFile(db,candidate);
      const top=relative(run.workDir,candidate).split(/[\\/]/)[0].toLowerCase();
      if (top==="inputs" || (top==="outputs" && e.runId && !run.endedAt)) {
        awaitingRun=true;
        return true;
      }
      return false;
    }
    for (const candidate of paths) {
      const exact=list.filter(f=>isAbsolute(f.path) && key(resolve(f.path))===key(resolve(candidate)));
      const saved=exact.find(f=>f.pinned) ?? exact[0];
      if (saved?.pinned) return {versionId:saved.versionId};
      if (saved) known.set(saved.assetId,saved.versionId);
      const preview=relative(join(db.root,"previews"),candidate).split(/[\\/]/);
      if ((preview.length===2 || preview.length===3) && /^[a-f\d-]{36}$/i.test(preview[0])) {
        const stored=db.get<{id:string}>(`SELECT v.id FROM asset_versions v JOIN assets a ON a.id=v.assetId
          WHERE v.id=? AND v.fileName=? AND a.projectId=? AND a.lifecycle='active'`,preview[0],preview.at(-1)!,e.projectId);
        if (stored) return {versionId:stored.id};
      }
      if (privatePath(candidate)) {outside=true;continue;}
      const explicit=direct && isAbsolute(path);
      const physical=await realpath(candidate).catch(err=>{if (["ENOENT","ENOTDIR"].includes(err.code))return null;throw err;});
      if (!physical) {
        if (!explicit && !bases.some(p=>contains(p,candidate))) outside=true;
        continue;
      }
      const pinned=list.find(f=>f.pinned && isAbsolute(f.path) && key(resolve(f.path))===key(physical));
      if(pinned) return {versionId:pinned.versionId};
      if(privatePath(physical) || (!explicit && !physicalRoots.some(p=>contains(p,physical)))){outside=true;continue;}
      const info=await stat(physical);
      if(info.isFile()) candidates.set(key(physical),physical);
      else if(info.isDirectory()) directory=true;
      if (isAbsolute(path)) break;
    }
    if(candidates.size>1) return {issue:"同名文件不唯一，需要具体路径"};
    const source=candidates.values().next().value;
    if(source) return {source,file:await new Files(db.root).ingest(source)};
    if (!known.size && !outside && basename(path)===path) {
      for (const f of list) if(key(basename(f.path))===key(path) && !known.has(f.assetId)) known.set(f.assetId,f.versionId);
    }
    if(known.size===1) return {versionId:[...known.values()][0]};
    return {issue:known.size>1?"同名文件不唯一，需要具体路径":directory?"引用为目录，需要具体文件":awaitingRun?"等待任务台登记本次运行文件":outside?"路径在授权文件范围之外":"未找到本地文件"};
  } catch(err) {
    const code=(err as NodeJS.ErrnoException).code;
    if(code==="ENOSPC") return {issue:"托管空间不足，等待重试"};
    if(code==="ENOENT") return {issue:"未找到本地文件"};
    if(code==="EACCES" || code==="EPERM") return {issue:"文件暂时无法读取"};
    return {issue:err instanceof Error?err.message.slice(0,180):"文件暂时无法读取"};
  }
}

function publishLocated(db:Store,e:FileEvidence,located:Located):{versionId:string|null;issue:string} {
  if ("issue" in located) return {versionId:null,issue:located.issue};
  if ("versionId" in located) {
    const accessible=db.get(`SELECT 1 FROM asset_versions v JOIN assets a ON a.id=v.assetId
      WHERE v.id=? AND a.projectId=? AND (a.lifecycle='active' OR ?=1)`,located.versionId,e.projectId,e.runId?1:0);
    return accessible?{versionId:located.versionId,issue:""}:{versionId:null,issue:"资产已归档或移入回收站"};
  }
  const {source,file}=located;
  const current=db.get<{id:string;version:number;lifecycle:string;ownedVersion:number|null;withdrawn:number|null}>(`
    SELECT a.id,a.version,a.lifecycle,o.ownedVersion,o.withdrawn FROM assets a LEFT JOIN conversation_owned_assets o ON o.assetId=a.id
    WHERE a.projectId=? AND a.sourceKey=? ORDER BY a.role='user' DESC LIMIT 1`,e.projectId,key(source));
  const owned=!current || current.version===current.ownedVersion;
  if (current && current.lifecycle!=="active") {
    if (!current.withdrawn || !owned) return {versionId:null,issue:"资产已归档或移入回收站"};
    db.write("UPDATE assets SET lifecycle='active',restoreAs='active',version=version+1 WHERE id=?",current.id);
  }
  const assetId=current?.id ?? randomUUID();
  if (!current) db.write("INSERT INTO assets(id,projectId,name,role,sourcePath,sourceKey) VALUES(?,?,?,?,?,?)",
    assetId,e.projectId,file.fileName,e.role==="output"?"output":"user",source,key(source));
  const versionId=db.addVersion(assetId,file);
  if(owned) db.write(`INSERT OR REPLACE INTO conversation_owned_assets(assetId,ownedVersion,withdrawn)
    SELECT id,version,0 FROM assets WHERE id=?`,assetId);
  return {versionId,issue:""};
}

export function saveFileEvidence(db:Store,e:FileEvidence,located:Located,taskId:string|null) {
  const id=fingerprint([e.projectId,e.threadId,e.turnId,e.itemId,e.role,e.path,taskId]);
  if(db.get("SELECT 1 FROM conversation_files WHERE id=? AND versionId IS NOT NULL",id))return;
  const {versionId,issue}=publishLocated(db,e,located);
  db.write(`INSERT INTO conversation_files(id,projectId,threadId,turnId,itemId,taskId,runId,role,path,quote,origin,cwd,occurredAt,versionId,issue,retryAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET versionId=excluded.versionId,issue=excluded.issue,retryAt=excluded.retryAt`,
    id,e.projectId,e.threadId,e.turnId,e.itemId,taskId,e.runId,e.role,e.path,e.quote,e.origin,e.cwd,e.occurredAt,versionId,issue,issue?Date.now()+300000:0);
  if (e.runId && versionId && e.origin!=="runInput" && e.origin!=="runOutput")
    db.write("DELETE FROM conversation_files WHERE runId=? AND role=? AND versionId=? AND origin IN ('runInput','runOutput')",e.runId,e.role,versionId);
}

// A taskboard turn also has a frozen input list and a verified delivery manifest.
export function saveRunFileEvidence(db:Store, runId:string) {
  const run=db.run(runId);
  if (!run.threadId || !run.turnId) return;
  const inputs=run.snapshot.files.map((f,index)=>({versionId:f.id,role:"material" as const,origin:"runInput" as const,
    path:"inputs/"+String(index+1).padStart(2,"0")+"-"+f.fileName}));
  const outputs=run.files.map(f=>({versionId:f.id,role:"output" as const,origin:"runOutput" as const,path:"outputs/"+f.path}));
  for (const file of [...inputs,...outputs]) {
    if (db.get("SELECT 1 FROM conversation_files WHERE runId=? AND role=? AND versionId=?",runId,file.role,file.versionId)) continue;
    const label=file.role==="material" ? "执行输入清单" : "执行交付清单";
    const at=file.role==="material"?run.startedAt:(run.endedAt ?? run.startedAt);
    saveFileEvidence(db,{projectId:run.projectId,threadId:run.threadId,turnId:run.turnId,
      itemId:label+"/"+runId,runId,cwd:run.workDir,occurredAt:Math.floor(Date.parse(at)/1000),path:file.path,
      role:file.role,origin:file.origin,quote:label+" · "+file.path},{versionId:file.versionId},run.taskId);
  }
}

export function syncRunFileEvidence(db:Store) {
  const runs=db.all<{id:string}>(`SELECT r.id FROM runs r JOIN projects p ON p.id=r.projectId
    JOIN project_policy x ON x.projectId=p.id
    WHERE p.lifecycle='active' AND x.capture=1 AND x.semanticScope<>'off' AND r.threadId IS NOT NULL AND r.turnId IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM thread_links l WHERE l.threadId=r.threadId AND l.kind='ignored')
      AND (EXISTS(SELECT 1 FROM json_each(r.snapshot,'$.files') f WHERE NOT EXISTS(SELECT 1 FROM conversation_files c
        WHERE c.taskId=r.taskId AND c.runId=r.id AND c.role='material' AND c.versionId=json_extract(f.value,'$.id')))
      OR EXISTS(SELECT 1 FROM run_files f WHERE f.runId=r.id AND NOT EXISTS(SELECT 1 FROM conversation_files c
        WHERE c.taskId=r.taskId AND c.runId=r.id AND c.role='output' AND c.versionId=f.versionId)))`);
  if (runs.length) db.transaction(()=>{for(const run of runs) saveRunFileEvidence(db,run.id);});
}

export async function retryConversationFiles(db:Store,projectId?:string) {
  const due=db.all<FileEvidence & {id:string; taskId:string|null}>(`SELECT * FROM conversation_files WHERE versionId IS NULL AND
    ((? IS NULL AND retryAt<=?) OR projectId=?) ORDER BY retryAt,rowid LIMIT 64`,projectId ?? null,Date.now(),projectId ?? null);
  for (const row of due) {
    function access() {
      const project=scopes(db).find(p=>p.id===row.projectId && p.semanticScope!=="off");
      if(!project)return;
      const link=existing(db,row.threadId);
      if(link?.kind==="ignored")return;
      const managed=db.get("SELECT 1 FROM runs WHERE threadId=? AND projectId=? AND (? IS NULL OR id=?)",
        row.threadId,row.projectId,row.runId,row.runId);
      if(managed || (link?.projectId===row.projectId && authorized(db,link))) return project;
    }
    const scope=access();
    if(!scope){db.write("UPDATE conversation_files SET retryAt=? WHERE id=? AND versionId IS NULL",Date.now()+300000,row.id);continue;}
    const located=await locateFile(db,row,scope);
    db.transaction(()=>{
      const latest=access();
      if(latest && JSON.stringify(latest.paths)===JSON.stringify(scope.paths) && latest.semanticScope===scope.semanticScope &&
          db.get("SELECT 1 FROM conversation_files WHERE id=? AND versionId IS NULL",row.id))
        saveFileEvidence(db,row,located,row.taskId);
    });
  }
}

export function fileHistory(db:Store,projectId:string) {
  return db.all<ConversationFile>(`SELECT c.id,c.threadId,c.turnId,c.runId,c.taskId,c.role,c.path,c.quote,c.versionId,c.issue,v.assetId,
    v.fileName,v.revision FROM conversation_files c LEFT JOIN asset_versions v ON v.id=c.versionId
    WHERE c.projectId=? ORDER BY c.occurredAt DESC,c.rowid DESC`,projectId);
}

export function conversationInputs(db:Store,taskId:string) {
  return db.all<InputFile>(`SELECT v.*,a.name,'input' role FROM conversation_files c JOIN asset_versions v ON v.id=c.versionId
    JOIN assets a ON a.id=v.assetId WHERE c.taskId=? AND c.role='material' AND a.lifecycle='active'
    AND NOT EXISTS(SELECT 1 FROM runs r,json_each(r.snapshot,'$.files') f
      WHERE r.id=c.runId AND json_extract(f.value,'$.id')=c.versionId)
    ORDER BY c.occurredAt DESC,v.revision DESC,c.rowid DESC`,taskId);
}

export function retractConversationFiles(db:Store,threadId:string) {
  const affected=db.all<{assetId:string}>(`SELECT DISTINCT v.assetId FROM conversation_files c JOIN asset_versions v ON v.id=c.versionId
    WHERE c.threadId=? AND c.runId IS NULL`,threadId);
  db.write("DELETE FROM conversation_files WHERE threadId=? AND runId IS NULL",threadId);
  for (const {assetId} of affected) {
    const changed=db.write(`UPDATE assets SET lifecycle='trash',restoreAs='active',version=version+1
      WHERE id=? AND lifecycle='active' AND context=0 AND version=(SELECT ownedVersion FROM conversation_owned_assets WHERE assetId=assets.id)
      AND NOT EXISTS(SELECT 1 FROM asset_versions v WHERE v.assetId=assets.id AND (
        EXISTS(SELECT 1 FROM conversation_files WHERE versionId=v.id) OR EXISTS(SELECT 1 FROM capture_refs WHERE versionId=v.id)
        OR EXISTS(SELECT 1 FROM task_inputs WHERE versionId=v.id) OR EXISTS(SELECT 1 FROM run_files WHERE versionId=v.id)
        OR EXISTS(SELECT 1 FROM projects WHERE handoffVersionId=v.id)))
      AND NOT EXISTS(SELECT 1 FROM asset_edits WHERE assetId=assets.id)
      AND NOT EXISTS(SELECT 1 FROM runs r,json_each(r.snapshot,'$.files') f WHERE r.projectId=assets.projectId AND json_extract(f.value,'$.assetId')=assets.id)`,assetId);
    if(changed.changes)db.write("UPDATE conversation_owned_assets SET ownedVersion=ownedVersion+1,withdrawn=1 WHERE assetId=?",assetId);
  }
}

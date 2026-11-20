import { handoffFor } from "./project-dashboard.ts";
import type { Store } from "./store.ts";
import type { CapturedState } from "./types.ts";
import { locateFile, saveFileEvidence, saveRunFileEvidence, type FileEvidence, type PreparedFile } from "./conversation-files.ts";
import { authorized, contains, existing, readTurns, recordAction, scopes, type Link, type Reader, type ThreadMeta, type Turn } from "./capture.ts";
import { batches, fingerprint, passagesFrom, validateAssessment, type Assessment, type Passage, type Profile, type ProposedTask, type ProposedUpdate, type Recognize } from "./semantic.ts";

interface Job { threadId: string; scope: string; wanted: number; processed: number; failures: number }
type Scope = ReturnType<typeof scopes>[number];
type Managed = { id:string; projectId:string; taskId:string; turnId:string|null; endedAt:string|null; startedAt:string };
export const captureRevision = "conversation-updates-1";

function plan(db: Store, meta: ThreadMeta) {
  const link = existing(db, meta.id);
  if (link?.kind === "ignored") return;
  const enabled = scopes(db);
  const managed = db.all<Managed>("SELECT id,projectId,taskId,turnId,startedAt,endedAt FROM runs WHERE threadId=? ORDER BY startedAt,id",meta.id);
  if (managed.length) {
    const owner = managed[0].projectId, projects = enabled.filter(p=>p.id===owner && p.semanticScope!=="off");
    if (!projects.length || managed.some(r=>r.projectId!==owner) || (link?.projectId && link.projectId!==owner)) return;
    return {link,projects,managed,key:fingerprint([captureRevision,owner,projects[0].semanticScope,projects[0].title,projects[0].description,
      link?.kind,link?.version, managed.map(r=>[r.id,r.turnId,Boolean(r.endedAt)])])};
  }
  const local = enabled.filter(p => p.paths.some(path => contains(path, meta.cwd)));
  let projects: Scope[];
  if (link?.projectId && (link.kind === "manual" || link.kind === "auto")) {
    projects = enabled.filter(p => p.id === link.projectId && p.semanticScope !== "off" &&
      (link.kind === "manual" || p.semanticScope === "all" || local.includes(p)));
  } else {
    // An explicitly configured directory rule continues to own its directory, including overlaps.
    if (local.some(p => p.semanticScope === "off")) return;
    projects = enabled.filter(p => p.semanticScope === "all" || (p.semanticScope === "roots" && local.includes(p)));
  }
  if (!projects.length) return;
  // Automatic ownership narrows future classification without invalidating the discovery receipt.
  const scopeProjects = link?.kind === "manual" ? projects : enabled.filter(p =>
    p.semanticScope === "all" || (p.semanticScope === "roots" && local.includes(p)));
  return { link, projects, managed, key: fingerprint([meta.cwd, scopeProjects.map(p => [p.id, p.title, p.description, p.semanticScope, p.paths]),
    link?.kind === "manual" ? [link.projectId, link.taskId, link.version] : null]) };
}

export function enqueueSemantic(db: Store, meta: ThreadMeta) {
  const p = plan(db, meta);
  if (!p) return false;
  const prior = db.get<Job>("SELECT * FROM semantic_jobs WHERE threadId=?", meta.id);
  const ids = JSON.stringify(p.projects.map(project => project.id));
  if (prior && prior.scope === p.key) {
    if (meta.updatedAt > prior.wanted) db.write("UPDATE semantic_jobs SET wanted=?,projectIds=? WHERE threadId=?", meta.updatedAt, ids, meta.id);
    return true;
  }
  db.transaction(() => {
    if (prior) db.write("DELETE FROM semantic_jobs WHERE threadId=?", meta.id);
    db.write("INSERT INTO semantic_jobs(threadId,scope,projectIds,wanted,queuedAt) VALUES(?,?,?,?,?)",
      meta.id, p.key, ids, meta.updatedAt, Date.now());
  });
  return true;
}
export function nextSemanticJob(db: Store) {
  return db.get<Job>("SELECT * FROM semantic_jobs WHERE processed<wanted AND retryAt<=? ORDER BY queuedAt,rowid LIMIT 1", Date.now());
}
export function retrySemanticJob(db: Store, job: Job, e: unknown) {
  const detail = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 220);
  const retryAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.failures, 7));
  db.write("UPDATE semantic_jobs SET failures=failures+1,retryAt=?,error=? WHERE threadId=? AND scope=?", retryAt, detail, job.threadId, job.scope);
}
export function semanticStatus(db: Store, projectId: string) {
  return db.get<{ pending: number; error: string }>(
    "SELECT count(*) pending,coalesce(max(error),'') error FROM semantic_jobs WHERE processed<wanted AND EXISTS(SELECT 1 FROM json_each(projectIds) WHERE value=?)",
    projectId);
}

function profile(db: Store, p: Scope, threadId:string): Profile {
  const tasks = db.all<Profile["tasks"][number]>(`
    WITH owners AS (SELECT c.taskId,c.threadId,c.taskVersion FROM capture_items c
      WHERE c.projectId=? AND c.created=1 AND c.status='active'
        AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.taskId=c.taskId)
        AND NOT EXISTS(SELECT 1 FROM task_reviews r WHERE r.taskId=c.taskId)),
    candidates AS (SELECT t.id,t.title,t.status,t.updatedAt,
      EXISTS(SELECT 1 FROM owners o WHERE o.taskId=t.id AND o.taskVersion=t.version AND o.threadId=?) capturedHere,
      EXISTS(SELECT 1 FROM owners o WHERE o.taskId=t.id AND o.taskVersion=t.version) capturedInProject
      FROM tasks t WHERE t.projectId=? AND t.lifecycle='active')
    SELECT id,title,status,capturedHere,capturedInProject FROM candidates WHERE capturedHere=1 OR id IN (
      SELECT id FROM candidates ORDER BY updatedAt DESC,id LIMIT 48) ORDER BY capturedHere DESC,updatedAt DESC,id`, p.id,threadId,p.id);
  const assets = db.all<{ name: string }>(
    "SELECT name FROM assets WHERE projectId=? AND lifecycle='active' ORDER BY context DESC,rowid DESC LIMIT 24", p.id);
  return { id: p.id, title: p.title, description: p.description.slice(0, 1200), tasks, assets: assets.map(a => a.name),
    handoffs:handoffFor(db,p.id).slice(0,48).map(({id,summary,quote})=>({id,summary,quote})) };
}

interface Part { passages: Passage[]; result: Assessment }

function updateSource(owner:string, threadId:string, p:Passage, update:ProposedUpdate, fixedTask:string|null, managed:Managed[]) {
  const run = managed.find(r=>r.turnId===p.turnId);
  const taskId = run?.taskId ?? fixedTask ?? update.taskId;
  return {runId:run?.id ?? null, taskId, id:fingerprint([owner,threadId,p.turnId,p.itemId,p.offset,update.kind,taskId])};
}

function writeUpdates(db: Store, meta:ThreadMeta, owner:string, parts:Part[], fixedTask:string|null, managed:Managed[], confirmed:boolean) {
  for (const {result,passages} of parts) {
    const match=result.matches.find(m=>m.projectId===owner);
    if (!match || (match.certainty!=="clear" && !confirmed)) continue;
    for (const update of result.updates ?? []) {
      if (update.projectId!==owner) continue;
      const p=passages[update.source];
      const {runId,taskId,id:sourceId}=updateSource(owner,meta.id,p,update,fixedTask,managed);
      const task=taskId ? db.get<{id:string}>("SELECT id FROM tasks WHERE id=? AND projectId=? AND lifecycle<>'trash'",taskId,owner) : undefined;
      if (taskId && !task) continue;
      const seconds=p.at || meta.updatedAt;
      const at=new Date(seconds<1e12 ? seconds*1000 : seconds).toISOString();
      const replaced=update.replacesId ? db.get<{id:string}>(
        "SELECT id FROM conversation_updates WHERE id=? AND projectId=? AND kind='handoff' AND occurredAt<=? AND id<>?",
        update.replacesId,owner,at,sourceId) : undefined;
      db.write(`INSERT OR IGNORE INTO conversation_updates(id,projectId,threadId,turnId,itemId,taskId,runId,kind,author,summary,quote,occurredAt,replacesId)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,sourceId,owner,meta.id,p.turnId,p.itemId,task?.id ?? null,runId,
        update.kind,p.author ?? "user",update.summary.trim(),update.quote,at,replaced?.id ?? null);
    }
  }
}

function stateEvidence(passage:Passage, quote:string, status:CapturedState["status"], fallbackAt:number): CapturedState {
  return {status,quote,author:passage.author ?? "user",turnId:passage.turnId,itemId:passage.itemId,
    at:passage.at ?? fallbackAt,itemIndex:passage.itemIndex ?? 0,offset:passage.offset+passage.text.indexOf(quote)};
}

function association(prior: Link | undefined, parts: Part[]) {
  const matches = new Map<string, { clear: boolean; quote: string; reason: string }>();
  for (const { result } of parts) for (const m of result.matches) {
    if (!matches.has(m.projectId) || m.certainty === "clear")
      matches.set(m.projectId, { clear: m.certainty === "clear", quote: m.quote, reason: m.reason });
  }
  const fixed = prior?.kind === "manual" || prior?.kind === "auto";
  const choices = [...matches.keys()].sort();
  const owner = fixed ? prior.projectId : choices.length === 1 && matches.get(choices[0])!.clear ? choices[0] : null;
  const proof = owner ? matches.get(owner) : undefined;
  return {matches,fixed,choices,owner,proof};
}

function saveAssessment(db: Store, meta: ThreadMeta, prior: Link | undefined, parts: Part[], turns: Turn[], requestsOnly = false) {
  const {matches,fixed,choices,owner,proof}=association(prior,parts);
  if (prior?.kind === "candidate") db.write("DELETE FROM thread_match_evidence WHERE threadId=?", meta.id);
  if (!fixed && !choices.length) {
    if (prior?.kind === "candidate") db.write("UPDATE thread_links SET choices='[]',matchBasis='semantic',matchReason='',summary='',version=version+1 WHERE threadId=?", meta.id);
    return;
  }
  if (!fixed) {
    const reason = proof?.reason ?? (choices.length > 1 ? "会话内容与多个项目有关，请确认归属。" : "会话与项目有关，现有内容不足以确定归属。");
    db.write(
      `INSERT INTO thread_links(threadId,projectId,cwd,name,summary,parentId,kind,choices,seenAt,matchBasis,matchReason) VALUES(?,?,?,?,?,?,?,?,?,'semantic',?)
       ON CONFLICT(threadId) DO UPDATE SET projectId=excluded.projectId,cwd=excluded.cwd,name=excluded.name,summary=excluded.summary,
       kind=excluded.kind,choices=excluded.choices,seenAt=excluded.seenAt,matchBasis='semantic',matchReason=excluded.matchReason,
       version=thread_links.version+1`,
      meta.id, owner, meta.cwd, meta.name || meta.id, proof?.quote.slice(0,360) || "", meta.forkedFromId ?? null,
      owner ? "auto" : "candidate", JSON.stringify(choices), meta.updatedAt, reason);
    if (!owner) for (const [projectId, evidence] of matches)
      db.write("INSERT INTO thread_match_evidence(threadId,projectId,reason,quote) VALUES(?,?,?,?)", meta.id, projectId, evidence.reason, evidence.quote);
  } else if (!requestsOnly) {
    if (prior?.kind === "auto" && proof?.clear)
      db.write("UPDATE thread_links SET matchBasis='semantic',matchReason=? WHERE threadId=?", proof.reason, meta.id);
    db.write("UPDATE thread_links SET seenAt=max(seenAt,?),name=?,summary=CASE WHEN ?<>'' THEN ? ELSE summary END WHERE threadId=?",
      meta.updatedAt, meta.name || prior?.name || meta.id, proof?.quote || "", proof?.quote.slice(0,360) || "", meta.id);
  }
  if (!owner || (!proof?.clear && !(prior?.kind === "manual" && proof))) return;
  const link = existing(db, meta.id)!;
  if (!requestsOnly) writeUpdates(db,meta,owner,parts,link.taskId,[],prior?.kind==="manual");
  const actions = new Map<string, { passage: Passage; task: ProposedTask; line: number; offset: number; state?:CapturedState }>();
  const changes: { task: ProposedTask; state: CapturedState; taskId?:string }[] = [];
  const gathered = new Map<string,string>();
  for (const { result, passages } of parts) {
    const match = result.matches.find(m => m.projectId === owner);
    if (!match || (match.certainty !== "clear" && prior?.kind !== "manual")) continue;
    for (const task of result.tasks) {
      if (task.projectId !== owner) continue;
      const state = task.state ? stateEvidence(passages[task.state.source],task.state.quote,task.state.status,meta.updatedAt) : undefined;
      if (task.stateOnly) {
        if (state) changes.push({task,state});
        continue;
      }
      const passage = passages[task.source], index = passage.text.indexOf(task.quote);
      const offset = passage.offset + index, line = passage.line + (passage.text.slice(0,index).match(/\n/g)?.length ?? 0);
      actions.set(JSON.stringify([passage.turnId, passage.itemId, offset]), { passage, task, line, offset, state });
    }
  }
  const seen = new Set<string>();
  const turnOrder = new Map(turns.map((turn,i)=>[turn.id,i]));
  const ordered = [...actions.values()].sort((a,b) => (turnOrder.get(a.passage.turnId) ?? 0)-(turnOrder.get(b.passage.turnId) ?? 0)
    || (a.passage.itemIndex ?? 0)-(b.passage.itemIndex ?? 0) || a.offset-b.offset);
  for (const { passage, task, line, offset, state } of ordered) {
    const base = passage.itemId + "/" + line;
    const key = passage.turnId + "/" + base;
    const anchor = seen.has(key) ? base + ":" + offset : base;
    seen.add(key);
    const captured = recordAction(db, link, passage.turnId, anchor, task.title.trim(), task.quote, task.existingTaskId, task.quote, state);
    if (!captured) continue;
    gathered.set(task.title.trim(),captured.id);
    const proof = state ?? (captured.created ? stateEvidence(passage,task.quote,"todo",meta.updatedAt) : undefined);
    if (proof) changes.push({task,state:proof,taskId:captured.id});
  }
  changes.sort(({state:a},{state:b}) => (turnOrder.get(a.turnId) ?? 0)-(turnOrder.get(b.turnId) ?? 0)
    || a.itemIndex-b.itemIndex || a.offset-b.offset);
  for (const {task,state,taskId} of changes) {
    const target = taskId ?? task.existingTaskId ?? gathered.get(task.title.trim());
    if (target) db.applyCapturedState(owner,meta.id,target,state);
  }
  return gathered;
}

// A linked conversation can receive new requests while its full history is still waiting for classification.
export function nextBoundRequests(db: Store) {
  return db.get<Job>(`SELECT j.* FROM semantic_jobs j JOIN thread_links l ON l.threadId=j.threadId
    JOIN project_policy p ON p.projectId=l.projectId JOIN projects a ON a.id=p.projectId
    LEFT JOIN semantic_receipts mark ON mark.threadId=j.threadId AND mark.digest='direct:through'
    LEFT JOIN semantic_receipts retry ON retry.threadId=j.threadId AND retry.digest='requests:retry'
    WHERE l.kind IN ('auto','manual') AND l.seenAt>=0 AND a.lifecycle='active' AND p.capture=1 AND p.semanticScope<>'off'
      AND j.wanted>max(l.seenAt,j.processed,coalesce(CAST(mark.result AS INTEGER),-1))
      AND coalesce(CAST(retry.result AS INTEGER),0)<=? AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.threadId=j.threadId)
      AND (j.processed<l.seenAt OR EXISTS(SELECT 1 FROM semantic_jobs other WHERE other.threadId<>j.threadId AND other.processed<other.wanted))
    ORDER BY j.wanted DESC,j.queuedAt LIMIT 1`,Date.now());
}

export async function captureBoundRequests(db: Store, job: Job, rpc: Reader, recognize: Recognize) {
  const { thread: meta } = await rpc.call<{thread:ThreadMeta}>("thread/read",{threadId:job.threadId,includeTurns:false});
  const p = plan(db,meta), link = p?.link, owner = link?.projectId;
  if (meta.id!==job.threadId || p?.key!==job.scope || !link || !owner || p.managed.length ||
      !["auto","manual"].includes(link.kind) || p.projects[0]?.id!==owner) return;
  const valid = () => {
    const current=plan(db,meta);
    return current?.key===job.scope && current.link?.projectId===owner && current.link.version===link.version &&
      !!db.get("SELECT 1 FROM semantic_jobs WHERE threadId=? AND scope=?",job.threadId,job.scope);
  };
  const receipt=(digest:string)=>db.get<{result:string}>("SELECT result FROM semantic_receipts WHERE threadId=? AND digest=?",meta.id,digest);
  const since=Math.max(link.seenAt,job.processed,Number(receipt("direct:through")?.result ?? -1));
  if (since>=job.wanted) return;
  const turns=await readTurns(rpc,meta.id,since,valid,true);
  // Keep original item indices so evidence from the comprehensive pass compares identically.
  const direct=turns.map(t=>({...t,items:t.items.map(i=>i.type==="userMessage" || i.type==="agentMessage"
    ? i : {type:"omitted",id:i.id})}));
  const key=(s:Passage)=>"direct:"+fingerprint([owner,s.turnId,s.itemId,s.offset,s.text,s.files ?? []]);
  const unread=passagesFrom(direct,since,"bound").filter(s=>!receipt(key(s)));
  // Keep a request and the same turn's delivery together when the batch budget permits.
  const groups:Passage[][]=[];
  let group:Passage[]=[];
  for (const turn of turns) {
    const current=unread.filter(s=>s.turnId===turn.id);
    if (!current.length) continue;
    if (group.length && batches([...group,...current]).length>1) { groups.push(group); group=[]; }
    const pieces=batches([...group,...current]);
    group=pieces.pop()!;
    groups.push(...pieces);
  }
  if (group.length) groups.push(group);
  for (const passages of groups) {
    if (!valid()) return;
    const input={projects:[profile(db,p.projects[0],meta.id)],passages,bound:true,requestsOnly:true,name:meta.name ?? ""};
    const result=validateAssessment(await recognize(input),input);
    if (!valid()) return;
    const parts=[{passages,result}];
    const prepared=await prepareFiles(db,meta,p.projects[0],parts,[],link.taskId,link.kind==="manual",valid);
    if (!valid()) return;
    db.transaction(()=>{
      const gathered=saveAssessment(db,meta,link,parts,turns,true);
      registerFiles(db,prepared,gathered);
      for (const s of passages) db.write("INSERT OR IGNORE INTO semantic_receipts VALUES(?,?,'null')",meta.id,key(s));
    });
  }
  if (valid()) db.write("INSERT OR REPLACE INTO semantic_receipts VALUES(?,'direct:through',?)",meta.id,String(job.wanted));
}

function reviewedPassage(owner: string, passage: Passage) {
  return "passage:" + fingerprint([owner, passage.turnId, passage.itemId, passage.offset, passage.text]);
}

function fileReceipt(owner:string,p:Passage) {
  return "files:" + fingerprint([reviewedPassage(owner,p),p.files ?? []]);
}

function fileTask(db: Store, projectId:string, threadId:string, taskKey:string|null, gathered?:Map<string,string>) {
  if (!taskKey) return null;
  const id=gathered?.get(taskKey) ?? taskKey;
  const known=db.get<{id:string}>("SELECT id FROM tasks WHERE projectId=? AND id=? AND lifecycle<>'trash'",projectId,id);
  if (known) return known.id;
  const choices=db.all<{id:string}>(`SELECT DISTINCT t.id FROM capture_items c JOIN tasks t ON t.id=c.taskId
    WHERE c.threadId=? AND c.projectId=? AND c.status='active' AND t.lifecycle<>'trash' AND (c.title=? OR t.title=?) LIMIT 2`,threadId,projectId,taskKey,taskKey);
  return choices.length===1 ? choices[0].id : null;
}

async function prepareFiles(db:Store, meta:ThreadMeta, project:Scope, parts:Part[], managed:Managed[], fixedTask:string|null, manual:boolean, valid:()=>boolean) {
  const prepared:PreparedFile[]=[];
  for (const {result,passages} of parts) {
    const match=result.matches.find(m=>m.projectId===project.id);
    if (!match || (match.certainty!=="clear" && !managed.length && !manual)) continue;
    for (const file of result.files ?? []) {
      if (file.projectId!==project.id) continue;
      const p=passages[file.source], run=managed.find(r=>r.turnId===p.turnId);
      if (managed.length && /(?:^|[\\/])(?:outputs[\\/](?:delivery|checkpoint)|inputs[\\/](?:manifest|index|conversation-handoff))\.json$/i.test(file.path)) continue;
      const evidence:FileEvidence={projectId:project.id,threadId:meta.id,turnId:p.turnId,itemId:p.itemId,
        cwd:meta.cwd,runId:run?.id ?? null,occurredAt:p.at ?? meta.updatedAt,role:file.role,path:file.path,
        quote:file.quote,origin:p.files?.find(h=>h.path===file.path)?.origin ?? "mention"};
      if (!valid()) return [];
      prepared.push({evidence,taskKey:run?.taskId ?? fixedTask ?? file.task,located:await locateFile(db,evidence,project)});
    }
  }
  return prepared;
}

function registerFiles(db:Store, prepared:PreparedFile[], gathered?:Map<string,string>) {
  for (const {evidence,located,taskKey} of prepared)
    saveFileEvidence(db,evidence,located,fileTask(db,evidence.projectId,evidence.threadId,taskKey,gathered));
}

export async function applySemanticJob(db: Store, job: Job, rpc: Reader, recognize: Recognize) {
  const { thread: meta } = await rpc.call<{ thread: ThreadMeta }>("thread/read", { threadId: job.threadId, includeTurns: false });
  if (meta.id !== job.threadId) throw new Error("会话标识不一致。");
  const first = plan(db, meta);
  if (!first || first.key !== job.scope) {
    db.write("DELETE FROM semantic_jobs WHERE threadId=? AND scope=?", job.threadId, job.scope);
    if (first) enqueueSemantic(db, meta);
    return;
  }
  const version = first.link?.version ?? 0;
  const valid = () => {
    const current = plan(db, meta);
    return current?.key === job.scope && (current.link?.version ?? 0) === version &&
      JSON.stringify(current.projects.map(p=>p.paths))===JSON.stringify(first.projects.map(p=>p.paths)) &&
      !!db.get("SELECT 1 FROM semantic_jobs WHERE threadId=? AND scope=?", job.threadId, job.scope);
  };
  const managedOwner = first.managed[0]?.projectId;
  if (managedOwner && valid()) db.transaction(()=>{
    for (const run of first.managed) saveRunFileEvidence(db,run.id);
  });
  const bound = !!managedOwner || first.link?.kind === "manual" || first.link?.kind === "auto";
  const since = bound ? job.processed : -1;
  const turns = await readTurns(rpc, job.threadId, since, valid, true);
  if (!valid()) return;
  const passages = passagesFrom(turns, since, managedOwner ? "managed" : bound ? "bound" : "conversation");
  const owner = managedOwner ?? (bound ? first.link?.projectId : null);
  const received=(digest:string)=>!!db.get("SELECT 1 FROM semantic_receipts WHERE threadId=? AND digest=?",job.threadId,digest);
  const unread=owner ? passages.filter(p=>!received(fileReceipt(owner,p))) : passages;
  const inherited = managedOwner ? db.all<{summary:string;quote:string}>(`SELECT DISTINCT json_extract(h.value,'$.summary') summary,
    json_extract(h.value,'$.quote') quote FROM runs r,json_each(r.snapshot,'$.conversationHandoff') h WHERE r.threadId=?
    AND r.projectId=? ORDER BY r.startedAt DESC LIMIT 48`,meta.id,managedOwner) : undefined;
  const mixed=!!managedOwner && !!first.link && first.link.projectId===managedOwner && authorized(db,first.link);
  const ownedTurns=new Set(first.managed.map(run=>run.turnId));
  const managedPassage=(p:Passage)=>!!managedOwner && (!mixed || ownedTurns.has(p.turnId));
  const groups:{passages:Passage[]; filesOnly:boolean; managed:boolean}[]=[];
  const backfill=Number(db.get<{result:string}>("SELECT result FROM semantic_receipts WHERE threadId=? AND digest='files:backfill-through'",job.threadId)?.result ?? -1);
  let buffer:Passage[]=[], historical=false, managedBatch=false;
  function flush() {
    for (const batch of batches(buffer)) groups.push({passages:batch,filesOnly:historical,managed:managedBatch});
    buffer=[];
  }
  for (const p of unread) {
    const previouslyReviewed=!!owner && (received(reviewedPassage(owner,p)) || (p.at!==undefined && p.at<=backfill));
    if (previouslyReviewed && !p.files?.length && !/\.[a-z0-9]{1,12}\b|[\\/]/i.test(p.text)) continue;
    if (historical!==previouslyReviewed || managedBatch!==managedPassage(p)) flush();
    managedBatch=managedPassage(p);
    historical=previouslyReviewed;
    buffer.push(p);
  }
  flush();
  const projects = first.projects.map(p => profile(db, p, meta.id));
  const managedTasks = new Set(first.managed.map(r=>r.taskId));
  const fixedTask = managedOwner ? (managedTasks.size===1 ? first.managed[0].taskId : null) : first.link?.taskId ?? null;
  const parts: Part[] = [];
  for (let i = 0; i < projects.length; i += 6) {
    const section = projects.slice(i, i + 6);
    const established = new Set<string>();
    for (const {passages,filesOnly,managed} of groups) {
      const input = { projects: section, passages, filesOnly, name: meta.name || "", bound, established:[...established], managed, inherited:managed?inherited:undefined };
      const digest = fingerprint(["semantic-files-1",filesOnly,managed,job.scope, bound, input.established, section.map(p => p.id), passages]);
      const cached = db.get<{ result: string }>("SELECT result FROM semantic_receipts WHERE threadId=? AND digest=?", job.threadId, digest);
      let result: Assessment;
      if (cached) result = JSON.parse(cached.result);
      else {
        if (!valid()) return;
        result = validateAssessment(await recognize(input), input);
        if (!valid()) return;
        db.write("INSERT OR REPLACE INTO semantic_receipts(threadId,digest,result) VALUES(?,?,?)", job.threadId, digest, JSON.stringify(result));
      }
      parts.push({ passages, result });
      for (const match of result.matches) {
        if (match.certainty==="clear" && passages[match.source].author!=="assistant") established.add(match.projectId);
      }
      for (const task of result.tasks) {
        const candidate=section.find(p=>p.id===task.projectId);
        if (task.stateOnly || task.existingTaskId || !candidate) continue;
        const pending=candidate.pendingTasks ??= [];
        if (!pending.includes(task.title)) pending.push(task.title);
      }
      // Later batches can refer to a handoff from this chat before the atomic commit.
      for (const update of result.updates ?? []) {
        const candidate=section.find(p=>p.id===update.projectId);
        if (!candidate || !result.matches.some(m=>m.projectId===candidate.id &&
          (m.certainty==="clear" || managedOwner || first.link?.kind==="manual"))) continue;
        const active=(candidate.handoffs ?? []).filter(h=>h.id!==update.replacesId);
        if (update.kind==="handoff") {
          const source=updateSource(candidate.id,meta.id,passages[update.source],update,fixedTask,first.managed);
          active.unshift({id:source.id,summary:update.summary});
        }
        candidate.handoffs=active.slice(0,48);
      }
    }
  }
  const ownerId=managedOwner ?? association(first.link,parts).owner;
  const project=first.projects.find(p=>p.id===ownerId);
  const nativeParts=managedOwner?parts.filter(part=>managedPassage(part.passages[0])):[];
  const humanParts=managedOwner?parts.filter(part=>!managedPassage(part.passages[0])):parts;
  const prepared=project ? [
    ...await prepareFiles(db,meta,project,nativeParts,first.managed,fixedTask,first.link?.kind==="manual",valid),
    ...await prepareFiles(db,meta,project,humanParts,[],first.link?.taskId??null,first.link?.kind==="manual",valid)
  ] : [];
  db.transaction(() => {
    if (!valid()) return;
    let gathered:Map<string,string>|undefined;
    if (managedOwner) writeUpdates(db,meta,managedOwner,nativeParts,fixedTask,first.managed,true);
    if (!managedOwner || humanParts.length) gathered=saveAssessment(db,meta,first.link,humanParts,
      mixed?turns.filter(t=>!ownedTurns.has(t.id)):turns);
    registerFiles(db,prepared,gathered);
    const linkedOwner = managedOwner ?? existing(db, meta.id)?.projectId;
    if (linkedOwner) for (const passage of unread) {
      for (const digest of [reviewedPassage(linkedOwner,passage),fileReceipt(linkedOwner,passage)])
        db.write("INSERT OR IGNORE INTO semantic_receipts(threadId,digest,result) VALUES(?,?,'null')",job.threadId,digest);
    }
    db.write("DELETE FROM semantic_receipts WHERE threadId=? AND digest='files:backfill-through'", job.threadId);
    const ids = linkedOwner ? [linkedOwner] : projects.map(p => p.id);
    db.write("UPDATE semantic_jobs SET processed=max(processed,?),projectIds=?,failures=0,error='',retryAt=0 WHERE threadId=? AND scope=?",
      Math.max(meta.updatedAt, job.wanted), JSON.stringify(ids), job.threadId, job.scope);
  });
}


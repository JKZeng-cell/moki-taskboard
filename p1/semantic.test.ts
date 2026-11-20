import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureService, changeLink, existing, ingestTurns, sessionState, type Reader, type ThreadMeta, type Turn } from "../src/capture.ts";
import { applySemanticJob, captureBoundRequests, nextBoundRequests, enqueueSemantic, nextSemanticJob, semanticStatus } from "../src/semantic-capture.ts";
import { handoffFor } from "../src/project-dashboard.ts";
import { batches, passagesFrom, validateAssessment, type Recognize } from "../src/semantic.ts";
import { policyFor, savePolicy, type Policy } from "../src/schedule.ts";
import { Files } from "../src/assets.ts";
import { fileHistory, locateFile, retryConversationFiles, syncRunFileEvidence, type FileEvidence } from "../src/conversation-files.ts";
import { fileHints } from "../src/conversation-file-hints.ts";
import { Store } from "../src/store.ts";
import type { Params } from "../src/types.ts";

type Chat = ThreadMeta & { turns: Turn[] };
function chat(cwd: string, text: string): Chat {
  return { id: randomUUID(), cwd, name: "会话", updatedAt: 100, turns: [
    { id: "turn", status: "completed", completedAt: 98, items: [{ id: "msg", type: "userMessage", content: [{ type: "text", text }] }] }
  ] };
}
function reader(chats: Chat[]) {
  const reads: string[] = [], lists: Params[] = [];
  const rpc: Reader = { initialize: async () => ({}), close() {}, async call<T>(method: string, p: Params = {}) {
    if (method === "thread/list") { lists.push(p); return { data: chats, nextCursor: null } as T; }
    const thread = chats.find(c => c.id === p.threadId);
    assert.ok(thread);
    if (method === "thread/read") return { thread } as T;
    assert.equal(method, "thread/turns/list");
    reads.push(thread.id);
    return { data: [...thread.turns].reverse(), nextCursor: null } as T;
  } };
  return { rpc, reads, lists };
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "moki-sem-test-")), db = new Store(dir);
  t.after(async () => { db.db.close(); await rm(dir, { recursive: true, force: true }); });
  const project = (title: string, scope: Policy["semanticScope"], path = join(dir, title)) => {
    const id = db.saveProject({ title, description: title + "的目标" }, path).id;
    savePolicy(db, { ...policyFor(db, id), id, capture: true, semanticScope: scope }, []);
    return id;
  };
  return { dir, db, project };
}

test("已关联会话的新请求先于历史队列写入，保留来源、状态、重试与完整归集进度", async t => {
  const {db,dir,project}=await fixture(t), projectId=project("任务台","all",dir);
  await writeFile(join(dir,"验收效果.md"),"# 实际交付");
  const thread=chat(dir,"旧要求"), meta={...thread,updatedAt:250};
  changeLink(db,{projectId,threadId:thread.id},thread);
  db.write("UPDATE thread_links SET seenAt=100 WHERE threadId=?",thread.id);
  const request={id:"new",type:"userMessage",content:[{type:"text",text:"资产增加时间信息"}]};
  thread.turns.push({id:"new-turn",startedAt:240,completedAt:null,status:"inProgress",items:[request,{type:"agentMessage",phase:"final_answer",id:"reply",text:"交付了验收效果.md"}]});
  thread.updatedAt=meta.updatedAt;
  enqueueSemantic(db,meta);
  const first=nextBoundRequests(db)!;
  const {rpc}=reader([thread]); let calls=0;
  const recognize:Recognize=async input=>{
    calls++;
    assert.ok(input.requestsOnly);
    const i=input.passages.findIndex(p=>p.text.includes("资产增加时间信息"));
    return {matches:[{projectId,source:i,quote:"资产增加时间信息",certainty:"clear",reason:"项目资产"}],
      tasks:[{projectId,source:i,quote:"资产增加时间信息",title:"显示资产时间",existingTaskId:null}],
      files:[{projectId,source:i+1,quote:"交付了验收效果.md",path:"验收效果.md",role:"output",task:"显示资产时间"}]};
  };
  await assert.rejects(captureBoundRequests(db,first,rpc,async()=>{throw Error("临时故障");}),/临时故障/);
  assert.equal(nextBoundRequests(db)?.threadId,thread.id);
  await captureBoundRequests(db,first,rpc,recognize);
  const source=sessionState(db,projectId).sources[0];
  assert.ok(sessionState(db,projectId).files.some(f=>f.taskId===source.taskId && f.role==="output" && f.versionId));
  assert.equal(source.anchor,"new/0"); assert.equal(source.recognizedState?.status,"todo");
  assert.equal(existing(db,thread.id)?.seenAt,100);
  assert.equal(nextSemanticJob(db)?.processed,-1);
  assert.equal(nextBoundRequests(db),undefined);
  await captureBoundRequests(db,first,rpc,recognize);
  assert.equal(calls,1);
  thread.updatedAt++; enqueueSemantic(db,thread);
  await captureBoundRequests(db,nextBoundRequests(db)!,rpc,recognize);
  assert.equal(calls,1);
  await applySemanticJob(db,nextSemanticJob(db)!,rpc,async input=>{
    const i=input.passages.findIndex(p=>p.text.includes("资产增加时间信息"));
    return {matches:[{projectId,source:i,quote:"资产增加时间信息",certainty:"clear",reason:"项目资产"}],
      tasks:[{projectId,source:i,quote:"资产增加时间信息",title:"显示资产时间",existingTaskId:source.taskId}]};
  });
  assert.equal(sessionState(db,projectId).sources.length,1);
  assert.equal(db.state(projectId).tasks.length,1);
  assert.equal(nextSemanticJob(db),undefined);
});

test("后台分类被旧会话占用时仍自动归集新的已关联需求",async t=>{
  const {db,dir,project}=await fixture(t), pid=project("资料管理","all",dir);
  const old=chat(dir,"旧历史"), active=chat(dir,"旧关联");
  changeLink(db,{projectId:pid,threadId:active.id},active);
  db.write("UPDATE thread_links SET seenAt=99 WHERE threadId=?",active.id);
  active.updatedAt=210;
  active.turns.push({id:"current",startedAt:200,status:"inProgress",items:[{id:"request",type:"userMessage",content:[{type:"text",text:"增加资料时间"}]}]});
  enqueueSemantic(db,old); enqueueSemantic(db,active);
  const {rpc}=reader([old,active]);
  const gate=Promise.withResolvers<void>();
  const service=new CaptureService(db,dir,async()=>rpc,async input=>{
    if (!input.requestsOnly) { await gate.promise; return {matches:[],tasks:[]}; }
    const source=input.passages.findIndex(s=>s.text==="增加资料时间");
    return {matches:[{projectId:pid,source,quote:"增加资料时间",certainty:"clear",reason:"资产视图"}],
      tasks:[{projectId:pid,source,quote:"增加资料时间",title:"显示资料时间",existingTaskId:null}]};
  });
  const drained=service.processPending();
  try {
    for(let i=0;i<100 && !sessionState(db,pid).sources.length;i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(sessionState(db,pid).sources[0]?.turnId,"current");
    assert.equal(nextSemanticJob(db)?.threadId,old.id);
  } finally {gate.resolve(); await drained;}
});

test("唯一语义归属复用已有任务，保留两项同一行原话、引用来源及重启幂等", async t => {
  const { db, dir, project } = await fixture(t);
  const audio = project("旁白制作", "all"), ship = project("包裹履约", "all");
  const known = db.saveTask({ projectId: audio, title: "录第一章旁白", instructions: "制作旁白" }).id;
  const thread = chat(join(dir,"其他"), "通勤时想听书，麻烦念下第一章。片尾的人声也请降噪。");
  const { rpc, lists } = reader([thread]);
  let calls = 0;
  const recognize: Recognize = async input => {
    calls++;
    assert.ok(input.projects.some(p => p.id === ship));
    assert.ok(input.projects.find(p => p.id === audio)?.tasks.some(task => task.id === known));
    return { matches: [{ projectId: audio, source: 0, quote: "通勤时想听书", reason: "章节听书交付", certainty: "clear" }],
      tasks: [{ projectId: audio, source: 0, quote: "麻烦念下第一章", title: "交付第一章录音", existingTaskId: known },
        { projectId: audio, source: 0, quote: "片尾的人声也请降噪", title: "片尾降噪", existingTaskId: null }] };
  };
  const service = new CaptureService(db, dir, async () => rpc, recognize);
  await service.scan(); await service.processPending();
  assert.equal(lists[0].currentAccountOnly, true);
  assert.equal(existing(db, thread.id)?.projectId, audio);
  assert.equal(existing(db, thread.id)?.matchBasis, "semantic");
  const rows = sessionState(db, audio).sources;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.taskId === known)?.evidence, "麻烦念下第一章");
  assert.ok(rows.some(r => r.title === "片尾降噪" && r.created === 1 && r.anchor.startsWith("msg/0:")));
  assert.equal(db.all("SELECT 1 FROM tasks WHERE status='todo'").length, 2);
  assert.equal(sessionState(db, ship).links.length, 0);
  const reopened = new Store(dir);
  try {
    const again = new CaptureService(reopened, dir, async () => rpc, recognize);
    await again.scan(); await again.processPending();
    assert.equal(calls, 1);
    assert.equal(sessionState(reopened, audio).sources.length, 2);
  } finally { reopened.db.close(); }
});

test("多项目及弱证据只建候选，理由按项目可见；手动确认仅归集所选项目，撤销后不再扫描", async t => {
  const { db, dir, project } = await fixture(t);
  const a = project("声音", "all"), b = project("物流", "all");
  const thread = chat(dir, "给章节录音。请打印面单。"), weak = chat(dir, "聊聊录音。");
  const { rpc } = reader([thread, weak]);
  const recognize: Recognize = async ({ passages, bound, projects }) => {
    if (passages[0].text === "聊聊录音。") return { matches: [{ projectId: a, source: 0, quote: "聊聊录音", reason: "未提及具体章节", certainty: "possible" }], tasks: [] };
    const projectsSeen = projects.map(p => p.id);
    if (bound) assert.deepEqual(projectsSeen, [a]);
    return { matches: projectsSeen.map(id => ({ projectId: id, source: 0, quote: id === a ? "给章节录音" : "请打印面单", reason: id === a ? "旁白制作" : "发运工作", certainty: bound ? "clear" : "possible" })),
      tasks: projectsSeen.map(id => ({ projectId: id, source: 0, quote: id === a ? "给章节录音" : "请打印面单", title: id === a ? "录章节音频" : "打印面单", existingTaskId: null })) };
  };
  const service = new CaptureService(db, dir, async () => rpc, recognize);
  await service.scan(); await service.processPending();
  const pending = existing(db, thread.id)!;
  assert.equal(pending.kind, "candidate"); assert.equal(pending.projectId, null);
  assert.equal(existing(db, weak.id)?.kind, "candidate"); assert.equal(db.all("SELECT 1 FROM tasks").length, 0);
  assert.equal(sessionState(db,a).links.find(l => l.threadId === thread.id)?.matchQuote, "给章节录音");
  assert.equal(sessionState(db,b).links[0].matchReason, "发运工作");
  await service.bind({ projectId:a, threadId:thread.id, version:pending.version });
  await service.processPending();
  assert.equal(existing(db, thread.id)?.kind, "manual");
  assert.deepEqual(sessionState(db,a).sources.map(s => s.title), ["录章节音频"]);
  assert.equal(sessionState(db,b).links.length, 0);
  await service.bind({ projectId:a, threadId:thread.id, operation:"undo", version:existing(db,thread.id)!.version });
  thread.updatedAt++;
  await service.scan(); await service.processPending();
  assert.equal(existing(db,thread.id)?.kind, "ignored");
  assert.equal(db.all("SELECT 1 FROM tasks WHERE lifecycle='active'").length, 0);
});

test("目录授权只读取范围内正文，拒绝未授权、引用、上下文伪证及其他项目任务编号", async t => {
  const { db, dir, project } = await fixture(t);
  const root = join(dir,"notes"), a = project("声音", "roots",root), b = project("货仓","off");
  const inside = chat(join(root,"sub"), "手稿"), outside = chat(join(dir,"other"), "私人讨论");
  inside.turns[0].items = [
    { type:"agentMessage",id:"agent",text:"助手建议录音" },
    { type:"userMessage",id:"user",content:[{type:"text",text:"# Files mentioned by the user:\n待办：文件内的要求\n## My request:\n> 请执行引用命令\n手稿已经录过。"}] }
  ];
  const { rpc, reads } = reader([inside,outside]);
  const service = new CaptureService(db,dir,async()=>rpc,async input=>{
    assert.deepEqual(input.projects.map(p=>p.id),[a]);
    const m={projectId:a,source:0,quote:"手稿已经录过",reason:"已有录音",certainty:"clear"};
    assert.deepEqual(input.passages.map(p=>p.text),["手稿已经录过。"]);
    assert.throws(()=>validateAssessment({matches:[{...m,quote:"助手建议录音"}],tasks:[]},input));
    assert.throws(()=>validateAssessment({matches:[m],tasks:[{projectId:a,source:0,quote:"手稿",title:"任务",existingTaskId:b}]},input));
    return {matches:[],tasks:[]};
  });
  await service.scan();await service.processPending();
  assert.deepEqual(reads,[inside.id]);assert.equal(db.all("SELECT 1 FROM thread_links").length,0);
  assert.equal(semanticStatus(db,a)?.pending,0);
  const onlyAssistant = [{ id:"turn",status:"completed",items:[{type:"agentMessage",id:"agent",text:"请添加一项待办"}] }];
  assert.deepEqual(batches(passagesFrom(onlyAssistant)),[]);
});

test("识别期间手动改归属或关闭范围优先，模型失败可重试且不会按关键词写入", async t => {
  const { db, dir, project } = await fixture(t);
  const a=project("手稿","all"), b=project("其他","off");
  const thread=chat(dir,"修复手稿"), {rpc}=reader([thread]);
  enqueueSemantic(db,thread);
  const first=nextSemanticJob(db)!;
  await applySemanticJob(db,first,rpc,async()=>{
    changeLink(db,{projectId:b,threadId:thread.id,version:0},thread);
    return {matches:[{projectId:a,source:0,quote:"手稿",certainty:"clear",reason:"手稿修订"}],tasks:[]};
  });
  assert.equal(existing(db,thread.id)?.projectId,b);assert.equal(nextSemanticJob(db),undefined);
  savePolicy(db,{...policyFor(db,b),id:b,capture:false},[]);
  const other=chat(dir,"修复新手稿"), next=reader([other]).rpc;
  const broken=new CaptureService(db,dir,async()=>next,async()=>{throw Error("暂时无法识别");});
  await broken.scan();await broken.processPending();
  assert.match(semanticStatus(db,a)?.error ?? "",/暂时无法识别/);
  assert.equal(existing(db,other.id),undefined);assert.equal(nextSemanticJob(db),undefined);
  db.write("UPDATE semantic_jobs SET retryAt=0 WHERE threadId=?",other.id);
  await applySemanticJob(db,nextSemanticJob(db)!,next,async()=>{
    savePolicy(db,{...policyFor(db,a),id:a,capture:false},[]);
    return {matches:[{projectId:a,source:0,quote:"新手稿",certainty:"clear",reason:"手稿修订"}],tasks:[]};
  });
  await broken.processPending();
  assert.equal(existing(db,other.id),undefined);assert.equal(db.all("SELECT 1 FROM tasks").length,0);
});

test("增量识别承接上轮助手方案，已处理的消息仅作上下文，新指代请求有自己的来源", async t => {
  const { db, dir, project } = await fixture(t);
  const a = project("音频后期","all"), thread = chat(dir,"这个章节的尾音一般怎么处理？");
  thread.turns[0].items.push({ id:"answer",type:"agentMessage",text:"可将片尾最后三秒做淡出。" });
  const { rpc } = reader([thread]);
  let calls = 0;
  const service = new CaptureService(db,dir,async()=>rpc,async ({ passages }) => {
    calls++;
    if (calls === 1) return { matches:[{ projectId:a,source:0,quote:"尾音",certainty:"clear",reason:"讨论音频处理" }],tasks:[] };
    assert.equal(passages.length,1); assert.equal(passages[0].context,"可将片尾最后三秒做淡出。");
    assert.equal(passages[0].text,"好，就按这个方案做一版。");
    return {matches:[{projectId:a,source:0,quote:"按这个方案做一版",certainty:"clear",reason:"确认片尾方案"}],
      tasks:[{projectId:a,source:0,quote:"按这个方案做一版",title:"制作三秒淡出的片尾",existingTaskId:null}]};
  });
  await service.scan();await service.processPending();assert.equal(db.all("SELECT 1 FROM tasks").length,0);
  thread.updatedAt=200;thread.turns.push({id:"next",status:"completed",completedAt:199,
    items:[{type:"userMessage",id:"new",content:[{type:"text",text:"好，就按这个方案做一版。"}]}]});
  await service.scan();await service.processPending();
  assert.deepEqual(sessionState(db,a).sources.map(s=>[s.turnId,s.evidence]),[["next","按这个方案做一版"]]);
  thread.updatedAt++;await service.scan();await service.processPending();
  assert.equal(calls,2);assert.equal(db.all("SELECT 1 FROM tasks").length,1);
});

test("会话更正追加执行记录、替代交接并固定下一次执行输入，撤销后恢复上一条",async t=>{
  const {db,dir,project}=await fixture(t);
  const a=project("录音","all");
  const task=db.saveTask({projectId:a,title:"音轨复核",instructions:"核对原始音轨"}).id;
  const before=chat(dir,"本项目交接是保留原始音轨，待授权再合成。");
  before.turns[0].items.push({type:"agentMessage",id:"report",text:"已经试听三段，均通过。"});
  const after=chat(dir,"授权已到，请改为先合成片头。");after.updatedAt=201;after.turns[0].completedAt=200;
  const chats=[before], {rpc}=reader(chats);
  const recognize:Recognize=async input=>{
    const prior=input.projects[0].handoffs?.[0], edit=input.passages[0].text.includes("授权已到");
    const quote=edit?"改为先合成片头":"保留原始音轨";
    const match={projectId:a,source:0,quote,certainty:"clear" as const,reason:"核对音轨交接"};
    const update={projectId:a,source:0,quote,kind:"handoff" as const,summary:quote,taskId:task,replacesId:edit?prior!.id:null};
    if(!edit) assert.throws(()=>validateAssessment({matches:[match],tasks:[
      {projectId:a,source:1,quote:"已经试听三段",title:"假行动",existingTaskId:null}]},input),/任务/);
    return {matches:[match],tasks:[],updates:edit?[update]:[update,{...update,source:1,kind:"progress",quote:"已经试听三段",summary:"试听完成"}]};
  };
  const service=new CaptureService(db,dir,async()=>rpc,recognize);
  await service.scan();await service.processPending();
  const original=handoffFor(db,a,task);assert.equal(original.length,1);
  const first=db.claim({id:task,version:1,requestKey:randomUUID()},false);
  assert.equal(db.run(first.id).snapshot.conversationHandoff![0].id,original[0].id);
  chats.push(after);await service.scan();await service.processPending();
  assert.deepEqual(handoffFor(db,a,task).map(h=>h.quote),["改为先合成片头"]);
  assert.equal(db.run(first.id).snapshot.conversationHandoff![0].quote,"保留原始音轨");
  const updates=db.state(a).dashboard!.updates;
  assert.equal(updates.length,3);assert.equal(updates.find(u=>u.kind==="progress")?.author,"assistant");
  assert.equal(updates.find(u=>u.id===original[0].id)?.current,0);
  await service.scan();await service.processPending();assert.equal(db.state(a).dashboard!.updates.length,3);
  changeLink(db,{projectId:a,threadId:after.id,version:existing(db,after.id)!.version,operation:"undo"});
  assert.deepEqual(handoffFor(db,a,task).map(u=>u.id),[original[0].id]);
});

test("任务台执行只收本次真实发言，记录精确关联运行与回合，不从派发模板创建待办",async t=>{
  const {db,dir,project}=await fixture(t),a=project("校对","roots");
  const task=db.saveTask({projectId:a,title:"核对",instructions:"执行一次校对"}).id;
  const run=db.claim({id:task,version:1,requestKey:randomUUID()},false);
  const thread=chat(join(dir,"separate"),"MOKI Taskboard run "+run.id+"\n"+"模板".repeat(2600));
  thread.turns[0].items.push({type:"agentMessage",id:"response",text:"校对完成，原文三处错字已经更正。"});
  db.write("UPDATE runs SET threadId=?,turnId=? WHERE id=?",thread.id,"turn",run.id);
  const service=new CaptureService(db,dir,async()=>reader([thread]).rpc,async input=>{
    assert.equal(input.managed,true);assert.equal(input.passages.length,1);
    assert.equal(input.passages[0].author,"assistant");assert.equal(input.passages[0].context,"");
    return {matches:[{projectId:a,source:0,quote:"校对完成",reason:"校对回报",certainty:"clear"}],tasks:[],
      updates:[{projectId:a,source:0,quote:"三处错字已经更正",kind:"progress",summary:"已修正三处错字",taskId:null,replacesId:null}]};
  });
  await service.scan();await service.processPending();
  const row=db.state(a).dashboard!.updates[0];
  assert.deepEqual([row.runId,row.taskId,row.turnId,row.author],[run.id,task,"turn","assistant"]);
  assert.equal(existing(db,thread.id),undefined);assert.equal(db.run(run.id).status,"running");
  assert.equal(db.state(a).tasks.length,1);
});

test("续接已绑定会话后仍归集用户的新任务，派发回合单独登记",async t=>{
  const {db,dir,project}=await fixture(t),owner=project("观测","all",dir);
  const id=db.saveTask({projectId:owner,title:"记录",instructions:"记录风速"}).id;
  const run=db.claim({id,version:1,requestKey:randomUUID()},false);
  const thread=chat(dir,"MOKI Taskboard run "+run.id+"\n执行记录"),next="另做一张降雨记录表";
  thread.turns[0].items.push({type:"agentMessage",id:"agent",text:"已交付风速记录"});
  thread.turns.push({id:"human",status:"completed",completedAt:100,items:[{type:"userMessage",id:"h",content:[{type:"text",text:next}]}]});
  db.write("INSERT INTO thread_links(threadId,projectId,cwd,name,kind) VALUES(?,?,?,?,'manual')",thread.id,owner,dir,"观测工作");
  db.progress(run.id,"执行中",thread.id,"turn");
  const modes:boolean[]=[];
  const service=new CaptureService(db,dir,async()=>reader([thread]).rpc,async input=>{
    modes.push(!!input.managed);
    const quote=input.passages[0].text;
    return {matches:[{projectId:owner,source:0,quote,certainty:"clear",reason:"观测"}],
      tasks:input.managed?[]:[{projectId:owner,source:0,quote,title:"降雨记录表",existingTaskId:null}]};
  });
  await service.scan();await service.processPending();
  assert.deepEqual(modes.sort(),[false,true]);assert.equal(db.state(owner).tasks.filter(t=>t.title==="降雨记录表").length,1);
});

test("长会话跨批更正同一交接时只把最终安排带进下一次执行",async t=>{
  const {db,dir,project}=await fixture(t),a=project("音轨","all"),source=chat(dir,"旧交接：等授权。");
  for(let i=1;i<=12;i++)source.turns.push({id:"t"+i,status:"completed",completedAt:100+i,
    items:[{type:"userMessage",id:"m"+i,content:[{type:"text",text:i===12?"更正：授权已到，开始合成。":"本轮核对音轨 "+i}]}]});
  const svc=new CaptureService(db,dir,async()=>reader([source]).rpc,async input=>{
    const first=input.passages[0].text.startsWith("旧交接"), quote=first?"等授权":"开始合成";
    const old=input.projects[0].handoffs?.[0]?.id;
    if(!first)assert.ok(old);
    return {matches:[{projectId:a,source:0,quote,certainty:"clear",reason:"音轨交接"}],tasks:[],
      updates:[{projectId:a,source:0,quote,kind:"handoff",summary:quote,taskId:null,replacesId:first?null:old!}]};
  });
  await svc.scan();await svc.processPending();
  assert.deepEqual(handoffFor(db,a).map(u=>u.quote),["开始合成"]);assert.equal(db.state(a).dashboard!.updates.length,2);
});

test("语义任务按七种状态直接落列，每项状态都有其原话，撤销可收回未接手的任务",async t=>{
  const {db,dir,project}=await fixture(t),a=project("节目交付","all");
  const entries=[["封面","todo","先记下来"],["清单","queued","请将清单加入执行队列"],["旁白","running","旁白正在录制"],
    ["样片","review","样片已交付等待验收"],["索引","done","索引我已验收完成"],["转码","error","转码执行失败"],["访谈","paused","请暂停访谈"]] as const;
  const thread=chat(dir,entries.map(([title,,quote])=>title+"："+(title==="样片"?"请制作样片":quote)).join("\n"));
  thread.turns[0].items.push({type:"agentMessage",id:"report",text:"样片已交付等待验收"});
  const {rpc}=reader([thread]);
  const recognize:Recognize=async input=>{
    const matches=[{projectId:a,source:0,quote:"封面",certainty:"clear" as const,reason:"节目制作"}];
    const tasks=entries.map(([title,status,quote])=>({projectId:a,source:0,quote:title,title,existingTaskId:null,
      state:status==="todo"?null:{status,source:title==="样片"?1:0,quote}}));
    for(const status of ["done","queued","unknown"])assert.throws(()=>validateAssessment({matches,tasks:[
      {...tasks[0],state:{status,source:1,quote:"样片已交付等待验收"}}]},input),/状态/);
    assert.throws(()=>validateAssessment({matches,tasks:[{...tasks[0],state:{status:"running",source:0,quote:"编造的开工回报"}}]},input),/状态/);
    return {matches,tasks};
  };
  const svc=new CaptureService(db,dir,async()=>rpc,recognize);
  await svc.scan();await svc.processPending();
  assert.deepEqual(db.state(a).tasks.map(t=>[t.title,t.status]).sort(),entries.map(([title,status])=>[title,status]).sort());
  const sources=sessionState(db,a).sources;
  assert.equal(sources.length,7);assert.equal(sources.find(s=>s.title==="样片")?.recognizedState?.author,"assistant");
  assert.equal(sources.find(s=>s.title==="样片")?.recognizedState?.quote,"样片已交付等待验收");
  const tasks=db.state(a).tasks;
  assert.equal(tasks.find(t=>t.status==="queued")?.queueRank,1);
  assert.ok(tasks.filter(t=>t.status!=="queued").every(t=>t.queueRank===null));
  assert.equal(db.all("SELECT 1 FROM task_reviews").length,0);assert.equal(db.all("SELECT 1 FROM runs").length,0);
  const manual=tasks.find(t=>t.title==="清单")!;db.changeTaskStatus({id:manual.id,version:manual.version,status:"paused"});
  changeLink(db,{projectId:a,threadId:thread.id,version:existing(db,thread.id)!.version,operation:"undo"});
  assert.deepEqual(db.all<{id:string}>("SELECT id FROM tasks WHERE lifecycle='active'").map(t=>t.id),[manual.id]);
});

test("会话跨批归集后承接新汇报，重复扫描、人工修改及真实执行各自保留其状态",async t=>{
  const {db,dir,project}=await fixture(t),a=project("样片","all"),thread=chat(dir,"请制作样片");
  for(let i=1;i<=12;i++)thread.turns.push({id:"t"+i,status:"completed",completedAt:100+i,items:[
    {type:"agentMessage",id:"m"+i,text:i===12?"样片已交付等你验收":"一般讨论 "+i}]});
  thread.updatedAt=120;
  const rpc=reader([thread]).rpc;let calls=0;
  const step=async(recognize:Recognize)=>{enqueueSemantic(db,thread);const job=nextSemanticJob(db);if(job)await applySemanticJob(db,job,rpc,async input=>{calls++;return recognize(input)});};
  const recognize:Recognize=async ({projects,passages})=>{
    const p=projects[0],start=passages[0].text==="请制作样片",bound=!!p.tasks.find(t=>t.capturedHere);
    const source=start?0:passages.findIndex(p=>p.text.includes("验收"));assert.ok(source>=0);
    const text=passages[source].text, match={projectId:a,source:start?0:source,quote:text,reason:"样片",certainty:"clear" as const};
    if(!start&&!bound)assert.deepEqual(p.pendingTasks,["制作样片"]);
    return {matches:[match],tasks:[{projectId:a,source,quote:text,title:"制作样片",existingTaskId:bound?p.tasks[0].id:null,
      stateOnly:!start,state:start?null:{status:bound?"done":"review",source,quote:text}}]};
  };
  // The follow-up batch contains only the assistant delivery of a user-authorized task.
  await step(async input=>{
    if(input.passages[0].text==="请制作样片")return recognize(input);
    assert.deepEqual(input.projects[0].pendingTasks,["制作样片"]);assert.deepEqual(input.established,[a]);
    const source=input.passages.findIndex(p=>p.author==="assistant"&&p.text.includes("已交付"));
    return {matches:[{projectId:a,source:0,quote:input.passages[0].text,reason:"样片",certainty:"clear"}],
      tasks:[{projectId:a,source,quote:"样片已交付",title:"制作样片",existingTaskId:null,stateOnly:true,state:{status:"review",source,quote:"样片已交付"}}]};
  });
  const first=db.state(a).tasks[0];assert.equal(first.status,"review");
  assert.equal(sessionState(db,a).sources[0].recognizedState?.turnId,"t12");
  function add(at:number,text:string){thread.updatedAt=at;thread.turns.push({id:"t"+at,status:"completed",completedAt:at-1,
    items:[{type:"userMessage",id:"u"+at,content:[{type:"text",text}]}]});}
  add(200,"样片我已验收，可以结项");await step(recognize);assert.equal(db.taskRow(first.id).status,"done");
  assert.equal(db.all("SELECT seq FROM task_reviews").length,0);
  const previousCalls=calls;thread.updatedAt++;await step(recognize);assert.equal(calls,previousCalls);
  add(300,"重新打开样片，暂停修订");await step(async input=>{
    const proof={source:0,quote:"暂停修订"};
    db.changeTaskStatus({id:first.id,version:db.taskRow(first.id).version,status:"queued"});
    return {matches:[{projectId:a,...proof,reason:"样片",certainty:"clear"}],tasks:[{projectId:a,...proof,title:"制作样片",
      existingTaskId:first.id,stateOnly:true,state:{...proof,status:"paused"}}]};
  });
  assert.equal(db.taskRow(first.id).status,"queued");
  const run=db.claim({id:first.id,version:db.taskRow(first.id).version,requestKey:randomUUID()},false);
  add(400,"样片已验收");await step(async input=>{assert.equal(input.projects[0].tasks[0].capturedHere,0);
    const matches=[{projectId:a,source:0,quote:"样片",reason:"样片",certainty:"clear" as const}];
    assert.throws(()=>validateAssessment({matches,tasks:[{projectId:a,source:0,quote:"样片",title:"制作样片",existingTaskId:first.id,
      stateOnly:true,state:{status:"done",source:0,quote:"样片已验收"}}]},input),/任务/);return {matches,tasks:[]};});
  assert.equal(db.run(run.id).status,"running");assert.equal(db.taskRow(first.id).status,"running");
  assert.equal(sessionState(db,a).sources.length,1);
});

test("同项目已绑定的另一个会话可凭新原话更新归集任务，保留原卡、人工状态和证据来源", async t => {
  const {db,dir,project}=await fixture(t), projectId=project("交付","all",dir);
  const original=chat(dir,"[ ] 核对片尾"), follow=chat(dir,"片尾已交给你核对");
  changeLink(db,{projectId,threadId:original.id},original);
  const link=existing(db,original.id)!;
  ingestTurns(db,link,original.turns,100,"");
  const task=db.state(projectId).tasks[0];
  assert.equal(task.status,"todo");
  changeLink(db,{projectId,threadId:follow.id},follow);
  follow.updatedAt=211;
  follow.turns=[{id:"turn",status:"completed",completedAt:210,items:[{id:"reply",type:"agentMessage",text:"片尾已交给你核对"}]}];
  enqueueSemantic(db,follow);
  await applySemanticJob(db,nextSemanticJob(db)!,reader([follow]).rpc,async input=>{
    const candidate=input.projects[0].tasks.find(t=>t.id===task.id)!;
    assert.equal(candidate.capturedHere,0);assert.equal(candidate.capturedInProject,1);
    const quote="片尾已交给你核对",evidence={projectId,source:0,quote};
    return {matches:[{...evidence,certainty:"clear",reason:"明确交付片尾"}],tasks:[{...evidence,title:task.title,
      existingTaskId:task.id,stateOnly:true,state:{source:0,quote,status:"review"}}]};
  });
  assert.equal(db.state(projectId).tasks.length,1);
  assert.equal(db.taskRow(task.id).status,"review");
  assert.equal(sessionState(db,projectId).sources[0].recognizedState?.threadId,follow.id);
  const marked=(at:number,text:string)=>ingestTurns(db,link,[{id:String(at),status:"completed",completedAt:at,
    items:[{id:"u",type:"userMessage",content:[{type:"text",text}]}]}],at,"");
  marked(180,"进行中：核对片尾");
  assert.equal(db.taskRow(task.id).status,"review");
  marked(230,"[x] 核对片尾");
  assert.equal(db.taskRow(task.id).status,"done");
  db.changeTaskStatus({id:task.id,version:db.taskRow(task.id).version,status:"paused"});
  marked(250,"Done: 核对片尾");
  assert.equal(db.taskRow(task.id).status,"paused");
});

test("v10 迁移仅重扫有语义来源且无人接手的旧任务，重扫在原卡上补状态",async t=>{
  const {db,dir,project}=await fixture(t),a=project("旧任务","all");
  const first=chat(dir,"请核对旧片尾"),second=chat(dir,"请核对旧片头");
  const {rpc}=reader([first,second]);
  const svc=new CaptureService(db,dir,async()=>rpc,async ({passages})=>{
    const proof={source:0,quote:passages[0].text};
    return {matches:[{...proof,projectId:a,reason:"节目交付",certainty:"clear"}],tasks:[{...proof,projectId:a,title:proof.quote,existingTaskId:null}]};
  });await svc.scan();await svc.processPending();
  const rows=sessionState(db,a).sources,one=rows.find(s=>s.threadId===first.id)!,two=rows.find(s=>s.threadId===second.id)!;
  db.changeTaskStatus({id:two.taskId,version:1,status:"paused"});
  db.db.exec("DROP TABLE conversation_files; DROP TABLE conversation_owned_assets; ALTER TABLE capture_items DROP COLUMN stateProof; PRAGMA user_version=10;");
  const migrated=new Store(dir);
  try {
    assert.equal(migrated.get("SELECT 1 FROM semantic_jobs WHERE threadId=?",first.id),undefined);
    assert.ok(migrated.get("SELECT 1 FROM semantic_jobs WHERE threadId=?",second.id));
    first.turns[0].items.push({type:"agentMessage",id:"delivery",text:"片尾已交付，请验收。"});
    enqueueSemantic(migrated,first);
    const pending=migrated.get<NonNullable<ReturnType<typeof nextSemanticJob>>>("SELECT * FROM semantic_jobs WHERE threadId=?",first.id)!;
    await applySemanticJob(migrated,pending,rpc,async input=>{
      assert.equal(input.projects[0].tasks.find(t=>t.id===one.taskId)?.capturedHere,1);
      return {matches:[{source:0,quote:"片尾",projectId:a,reason:"原任务",certainty:"clear"}],tasks:[{projectId:a,source:1,quote:"片尾已交付",
        title:one.title,existingTaskId:one.taskId,stateOnly:true,state:{status:"review",source:1,quote:"片尾已交付"}}]};
    });assert.equal(migrated.state(a).tasks.length,2);assert.equal(migrated.taskRow(one.taskId!).status,"review");
    assert.equal(migrated.taskRow(two.taskId!).status,"paused");assert.equal(sessionState(migrated,a).sources.length,2);
  }finally{migrated.db.close();}
});

test("会话归集真实资料和产物，新任务固定资料版本，按回合去重，缺失文件可单独补采",async t=>{
  const {db,dir,project}=await fixture(t),root=join(dir,"资料库");
  await mkdir(root);const pid=project("片单","roots",root), files=new Files(dir);
  const a=join(root,"客户清单.csv"), b=join(root,"交付汇总.md"), late=join(root,"迟到附件.pdf");
  await writeFile(a,"name\n一");await writeFile(b,"# 交付汇总");
  const thread=chat(root,"请制作片单，使用清单和迟到附件.pdf。"), caption="汇总片单";
  thread.turns[0].items[0].content!.push({type:"mention",path:a});
  thread.turns[0].items.push({type:"fileChange",id:"write",status:"completed",changes:[{kind:{type:"add"},path:b}]});
  const service=new CaptureService(db,root,async()=>reader([thread]).rpc,async ({passages,projects})=>{
    const p=passages[0], next=p.text.includes("再版"), known=projects[0].tasks[0]?.id;
    const match={source:0,projectId:pid,quote:p.text,reason:"工作素材",certainty:"clear" as const};
    const base={source:0,projectId:pid,quote:p.text,task:next?known!:caption};
    if(next)return {matches:[match],tasks:[],files:[{...base,path:"客户清单.csv",role:"material"}]};
    assert.equal(p.files?.[0].origin,"attachment");
    return {matches:[match],tasks:[{...match,title:caption,existingTaskId:null}],
      files:[{...base,path:a,role:"material"},{...base,path:"迟到附件.pdf",role:"material"},
        {...base,source:1,path:b,quote:b,role:"output"},{...base,path:"凭空编造.txt",role:"output"}]};
  });
  await service.scan();await service.processPending();
  const task=db.state(pid).tasks[0], old=fileHistory(db,pid);
  assert.equal(old.length,3);assert.ok(old.every(f=>f.taskId===task.id && f.threadId===thread.id));
  const input=old.find(f=>f.path===a)!,output=old.find(f=>f.path===b)!,missing=old.find(f=>f.issue)!;
  assert.equal(missing.versionId,null);assert.equal(db.state(pid).assets.length,2);
  assert.equal(await readFile(await files.preview(db.version(pid,output.versionId)),"utf8"),"# 交付汇总");
  const run=db.claim({id:task.id,version:task.version,requestKey:randomUUID()},false);
  assert.deepEqual(db.run(run.id).snapshot.files.map(f=>f.id),[input.versionId]);
  await writeFile(a,"name\n二");thread.updatedAt=210;thread.turns.push({id:"next",status:"completed",completedAt:209,
    items:[{type:"userMessage",id:"r",content:[{type:"text",text:"片单再版，已更新客户清单.csv。"}]}]});
  await service.scan();await service.processPending();const changed=fileHistory(db,pid).find(f=>f.turnId==="next")!;
  assert.equal(changed.assetId,input.assetId);assert.equal(changed.revision,2);
  assert.deepEqual(db.run(run.id).snapshot.files.map(f=>f.id),[input.versionId]);
  assert.equal(await readFile(await files.preview(db.version(pid,input.versionId)),"utf8"),"name\n一");
  await writeFile(late,Buffer.from([0,1,254]));await retryConversationFiles(db,pid);
  const found=fileHistory(db,pid).find(f=>f.id===missing.id)!;
  assert.equal(found.issue,"");assert.deepEqual(await readFile(await files.preview(db.version(pid,found.versionId))),Buffer.from([0,1,254]));
  await service.scan();await service.processPending();assert.equal(fileHistory(db,pid).length,4);
  assert.equal(db.all("SELECT 1 FROM asset_versions").length,4);assert.equal(db.all("SELECT 1 FROM run_files").length,0);
  const adopted=db.importFiles(pid,[await files.importFile(b)])[0];assert.equal(adopted.id,output.assetId);
  changeLink(db,{projectId:pid,threadId:thread.id,operation:"undo",version:existing(db,thread.id)!.version});
  assert.equal(fileHistory(db,pid).length,0);
  const assets=db.state(pid).assets;assert.equal(assets.find(x=>x.id===input.assetId)?.lifecycle,"active");
  assert.equal(assets.find(x=>x.id===output.assetId)?.lifecycle,"active");assert.equal(assets.find(x=>x.id===found.assetId)?.lifecycle,"trash");
});

test("文件范围、同名资料、宿主附件、失败写入和项目候选均按实际来源处理",async t=>{
  const {db,dir,project}=await fixture(t), root=join(dir,"root"), extra=join(dir,"extra"), other=join(dir,"else");
  await Promise.all([root,extra,other].map(p=>mkdir(p)));const pid=project("项目一","all",root), pid2=project("项目二","all",extra);
  for(const p of [root,extra,other])await writeFile(join(p,"资料.md"),p);
  await symlink(other,join(root,"外部"),"junction");
  const thread=chat(root,"请用资料.md 准备清单。");
  const base:FileEvidence={projectId:pid,threadId:thread.id,turnId:"turn",itemId:"msg",runId:null,role:"material",path:"资料.md",quote:"资料.md",origin:"mention",occurredAt:99,cwd:root};
  const access={id:pid,semanticScope:"all",paths:[root,extra]};
  assert.match((await locateFile(db,base,access) as {issue:string}).issue,/不唯一/);
  for(const path of [join(other,"资料.md"),join(root,"外部","资料.md"),"../else/资料.md"])
    assert.match((await locateFile(db,{...base,path},access) as {issue:string}).issue,/范围/);
  assert.ok("file" in await locateFile(db,{...base,origin:"attachment",path:join(other,"资料.md")},access));
  assert.ok("issue" in await locateFile(db,{...base,path:"https://example.invalid/资料.md"},access));
  const fileChange={type:"fileChange",id:"patch",changes:[{path:"old.md",kind:{type:"update",move_path:"new.md"}},{path:"deleted.md",kind:{type:"delete"}}]};
  assert.deepEqual(fileHints({...fileChange,status:"failed"},""),[]);assert.deepEqual(fileHints({...fileChange,status:"completed"},""),[{path:"new.md",origin:"written"}]);
  const svc=new CaptureService(db,root,async()=>reader([thread]).rpc,async({projects,bound})=>{
    const matches=projects.map(p=>({projectId:p.id,certainty:bound?"clear" as const:"possible" as const,reason:"归属",source:0,quote:"资料.md"}));
    return {matches,tasks:[],files:matches.map(m=>({...m,path:"资料.md",role:"material",task:null}))};
  });await svc.scan();await svc.processPending();assert.equal(existing(db,thread.id)?.kind,"candidate");
  assert.equal(db.state(pid).assets.length+db.state(pid2).assets.length,0);
  await svc.bind({projectId:pid,threadId:thread.id,version:existing(db,thread.id)!.version});await svc.processPending();
  assert.equal(fileHistory(db,pid).length,1);assert.equal(fileHistory(db,pid)[0].taskId,null);assert.equal(db.state(pid2).assets.length,0);
});

test("任务台会话复用当次执行的冻结资料与真实交付，忽略派发清单",async t=>{
  const {db,dir,project}=await fixture(t),pid=project("对单","roots",dir),files=new Files(dir);
  const src=join(dir,"原表.txt");await writeFile(src,"v1");const material=db.importFiles(pid,[await files.importFile(src)])[0];
  const task=db.saveTask({projectId:pid,title:"对单",instructions:"核对原表",inputVersionIds:[material.versionId]}).id;
  const run=db.claim({id:task,version:1,requestKey:randomUUID()},false), work=db.run(run.id).workDir;
  await mkdir(join(work,"outputs"),{recursive:true});const out=join(work,"outputs","报告.md");await writeFile(out,"正确");
  await writeFile(src,"v2");db.importFiles(pid,[await files.importFile(src)]);
  const thread=chat(work,"MOKI Taskboard run "+run.id);thread.turns[0].items.push({id:"agent",type:"agentMessage",text:"用了 inputs/01-原表.txt，交付 outputs/报告.md，登记 outputs/delivery.json。"});
  db.write("UPDATE runs SET threadId=?,turnId=? WHERE id=?",thread.id,"turn",run.id);
  const finished=db.finish(run.id,"completed",{summary:"已交付",checks:[],files:[{...await files.ingest(out),path:"报告.md",role:"output"}]});
  const service=new CaptureService(db,dir,async()=>reader([thread]).rpc,async({passages})=>{
    const proof={projectId:pid,source:0,quote:passages[0].text};
    return {matches:[{...proof,reason:"交付",certainty:"clear"}],tasks:[],files:[
      {...proof,role:"material",path:"inputs/01-原表.txt",task:null},{...proof,role:"output",path:"outputs/报告.md",task:null},
      {...proof,role:"output",path:"outputs/delivery.json",task:null}]};
  });await service.scan();await service.processPending();
  const rows=fileHistory(db,pid);assert.equal(rows.length,2);assert.ok(rows.every(f=>f.taskId===task && f.issue===""));
  assert.equal(rows.find(f=>f.role==="material")?.versionId,material.versionId);
  assert.equal(rows.find(f=>f.role==="output")?.versionId,finished.files[0].id);
  assert.equal(db.state(pid).assets.length,2);assert.equal(db.all("SELECT 1 FROM run_files").length,1);
  db.write("DELETE FROM conversation_files WHERE runId=?",run.id);
  syncRunFileEvidence(db);syncRunFileEvidence(db);
  const fromManifests=fileHistory(db,pid);assert.equal(fromManifests.length,2);
  assert.ok(fromManifests.every(f=>f.quote.includes("清单") && f.taskId===task && f.versionId));
  assert.equal(fromManifests.find(f=>f.role==="material")?.versionId,material.versionId);
});

test("v11 已授权会话补采历史资料，只补文件且保留人工任务状态",async t=>{
  const {db,dir,project}=await fixture(t),pid=project("校样","roots",dir),thread=chat(dir,"请核对校样.md。");
  await writeFile(join(dir,"校样.md"),"校样");
  const rpc=reader([thread]).rpc;const proof={projectId:pid,source:0,quote:"核对校样.md"};
  const matches=[{...proof,reason:"校样",certainty:"clear" as const}];
  enqueueSemantic(db,thread);await applySemanticJob(db,nextSemanticJob(db)!,rpc,async()=>({matches,tasks:[{...proof,title:"核对校样",existingTaskId:null}]}));
  const card=db.state(pid).tasks[0];db.changeTaskStatus({id:card.id,version:card.version,status:"paused"});
  db.db.exec("DROP TABLE conversation_files; DROP TABLE conversation_owned_assets; DELETE FROM semantic_receipts WHERE digest LIKE 'files:%'; PRAGMA user_version=11;");
  const current=new Store(dir);
  try {
    await applySemanticJob(current,nextSemanticJob(current)!,rpc,async input=>{
      assert.equal(input.filesOnly,true);return {matches,tasks:[{...proof,title:"不应新增",existingTaskId:null}],
        updates:[{...proof,kind:"progress",summary:"不应重记",taskId:null,replacesId:null}],
        files:[{...proof,role:"material",path:"校样.md",task:card.id}]};
    });
    assert.equal(current.state(pid).tasks.length,1);assert.equal(current.taskRow(card.id).status,"paused");
    assert.deepEqual(current.state(pid).dashboard?.updates,[]);assert.equal(fileHistory(current,pid)[0]?.taskId,card.id);
    assert.equal(nextSemanticJob(current),undefined);assert.equal(current.get<{integrity_check:string}>("PRAGMA integrity_check")?.integrity_check,"ok");
  }finally{current.db.close();}
});

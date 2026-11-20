import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Store} from "../src/store.ts";
import {Files} from "../src/assets.ts";
import {Runner} from "../src/runner.ts";
import {candidatesFor,chooseRoute,dispatchRoute,projectSessionOptions} from "../src/session-routing.ts";
import {codexPermission} from "../src/execution-permissions.ts";
import {pendingApprovals} from "../src/approval-reminders.ts";

async function fixture(t:TestContext) {
  const root=await mkdtemp(join(tmpdir(),"moki-dispatch-test-")),db=new Store(root);
  t.after(async()=>{db.db.close();await rm(root,{recursive:true,force:true});});
  const project=db.saveProject({title:"交接",permission:"read-only"},root);
  const task=db.saveTask({projectId:project.id,title:"观测便笺",instructions:"补全气象记录"}).id;
  const run=db.run(db.claim({id:task,version:1,requestKey:randomUUID()},false).id);
  return {root,db,project,task,run};
}

test("项目权限随领取固定，关联候选仅来自本项目有效的会话",async t=>{
  const {root,db,project,task,run}=await fixture(t);
  db.saveProject({id:project.id,title:"交接",version:1,permission:"review"},root);
  assert.equal(db.run(run.id).snapshot.permission,"read-only");
  assert.equal(db.state(project.id).project?.permission,"review");
  const other=db.saveProject({title:"其他"},join(root,"other"));
  for(const [tid,pr,kind,parent] of [["local",project.id,"manual",null],["foreign",other.id,"manual",null],["ignored",project.id,"ignored",null],
    ["candidate",project.id,"candidate",null],["subagent",project.id,"auto","local"]]){
    db.write("INSERT INTO thread_links(threadId,projectId,taskId,cwd,name,summary,kind,parentId) VALUES(?,?,?,?,?,?,?,?)",
      tid,pr,tid==="local"?task:null,root,"观测记录","气象值需要交接",kind,parent);
  }
  const candidates=candidatesFor(db,run);
  assert.deepEqual(candidates.map(c=>c.threadId),["local"]);assert.equal(candidates[0].sameTask,1);
  const route=await chooseRoute(run,candidates,async()=>({choice:1,evidence:"气象值需要交接"}));
  assert.equal(route.threadId,"local");
  for(const result of [{choice:2,evidence:"观测记录"},{choice:1,evidence:"虚构引文"},{choice:0,evidence:""}])
    assert.equal((await chooseRoute(run,candidates,async()=>result)).kind,"new");
  const refine={...run,snapshot:{...run.snapshot,refinement:{requirements:["本次在新会话中处理"],previousRunId:run.id,previousSummary:""}}};
  assert.equal((await chooseRoute(refine,candidates,async()=>assert.fail("explicit choice"))).kind,"new");
  refine.snapshot.refinement.requirements=["继续优化"];
  assert.equal((await chooseRoute(refine,candidates,async()=>assert.fail("explicit choice"))).threadId,"local");
  assert.deepEqual(codexPermission("read-only",root).sandboxPolicy,{type:"readOnly",networkAccess:false});
  assert.equal(codexPermission("review",root).approvalPolicy,"untrusted");
  assert.throws(()=>codexPermission("unavailable",root));
});

test("手选项目会话和强制新建覆盖语义，重放固定选择，取消归属后停止派发",async t=>{
  const {db,root,project,task,run}=await fixture(t);
  db.finish(run.id,"failed",{files:[],checks:[],summary:""},"隔离用例");
  const other=db.saveProject({title:"另一个项目"},join(root,"other"));
  for(const [thread,owner,kind] of [["selected",project.id,"manual"],["other",other.id,"manual"],["discard",project.id,"ignored"]]){
    db.write("INSERT INTO thread_links(threadId,projectId,cwd,name,summary,kind) VALUES(?,?,?,?,?,?)",thread,owner,root,"项目会话","",kind);
  }
  assert.deepEqual(projectSessionOptions(db,project.id).map(o=>o.threadId),["selected"]);
  const key=randomUUID(),version=db.taskRow(task).version;
  const claim=(choice:object)=>db.claim({id:task,version,requestKey:key,sessionChoice:choice},false);
  assert.throws(()=>claim({mode:"existing",threadId:"other"}),/不属于/);
  const choice={mode:"existing",threadId:"selected"},selected=claim(choice);
  assert.equal(claim(choice).created,false);
  assert.throws(()=>claim({mode:"new"}),/已使用/);
  const current=db.run(selected.id);
  const noSemantic=async()=>assert.fail("手动选择不应调用分类器");
  assert.equal((await dispatchRoute(db,current,noSemantic)).threadId,"selected");
  const fresh={...current,snapshot:{...current.snapshot,sessionChoice:{mode:"new" as const}}};
  assert.equal((await dispatchRoute(db,fresh,noSemantic)).kind,"new");
  db.write("UPDATE thread_links SET kind='ignored' WHERE threadId='selected'");
  await assert.rejects(dispatchRoute(db,current,noSemantic),/不属于/);
});

test("额外权限按项目任务精确提示，允许仅覆盖原请求与本回合，拒绝后队列清空",async t=>{
  const {root,db,run,project}=await fixture(t),runner=new Runner(db,new Files(root));
  const threadId=randomUUID(),turnId=randomUUID();db.progress(run.id,"执行中",threadId,turnId);
  const args={itemId:"p",threadId,turnId,cwd:root,permissions:{network:{enabled:true}},reason:"测试请求"};
  const method="item/permissions/requestApproval", empty={permissions:{},scope:"turn"};
  assert.deepEqual(await runner.approval(run.id,method,{...args,threadId:randomUUID()}),empty);
  const decision=runner.approval(run.id,method,args);
  const [a]=pendingApprovals(db);
  assert.deepEqual([a.projectId,a.runId,a.taskTitle],[project.id,run.id,"观测便笺"]);
  assert.deepEqual(await runner.approval(run.id,method,{...args,permissions:{fileSystem:{write:[root]}}}),empty);
  runner.decide(a.id,run.id,"accept");assert.deepEqual(await decision,{permissions:args.permissions,scope:"turn"});
  assert.deepEqual(await runner.approval(run.id,method,{...args,permissions:{fileSystem:{write:[root]}}}),empty);
  const denied=runner.approval(run.id,method,{...args,itemId:"b"});
  runner.decide(pendingApprovals(db)[0].id,run.id,"decline");assert.deepEqual(await denied,empty);
  assert.equal(pendingApprovals(db).length,0);
});

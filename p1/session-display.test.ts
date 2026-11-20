import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Files } from "../src/assets.ts";
import type { Reader } from "../src/capture.ts";
import { Store } from "../src/store.ts";
import { completeSummary, summaryFile } from "../src/session-summary.ts";
import { taskAssetGroups } from "../src/ui/asset-groups.ts";
import { sessionAssetGroups } from "../src/ui/asset-sessions.ts";

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "moki-session-display-"));
  const root = join(dir, "project"), data = join(dir, "store");
  await mkdir(root); await mkdir(data);
  const db = new Store(data), files = new Files(data);
  t.after(async () => { db.db.close(); await rm(dir, { recursive: true, force: true }); });
  const pid = db.saveProject({ title: "测试项目" }, root).id;
  function bind(name: string, summary = "", kind = "manual") {
    const tid = randomUUID();
    db.write("INSERT INTO thread_links(threadId,projectId,cwd,name,summary,kind) VALUES (?,?,?,?,?,?)", tid, pid, root, name, summary, kind);
    return tid;
  }
  async function asset(name: string, body = name) {
    const path = join(root, name);
    await writeFile(path, body);
    return db.importFiles(pid, [await files.importFile(path)])[0];
  }
  return { db, root, dir, pid, bind, asset, files };
}

test("会话分组按会话 ID 合并多条文件证据，涵盖旧执行输入输出、引用和未关联资产", async t => {
  const { db, pid, bind, asset, files, root } = await setup(t);
  const a = bind("同名会话"), b = bind("同名会话"), pending = bind("候选", "", "candidate");
  const shared = await asset("共享资料.md"), older = await asset("版本记录.md");
  await asset("版本记录.md", "第二版");
  const free = await asset("独立资料.md");
  const ref = (tid: string, vid: string) => db.write("INSERT INTO capture_refs VALUES (?,?,?,?,?)", tid, randomUUID(), pid, vid, "资料");
  ref(b, shared.versionId); ref(b, shared.versionId); ref(a, older.versionId); ref(pending, free.versionId);
  db.write(`INSERT INTO conversation_files(id,projectId,threadId,turnId,itemId,role,path,quote,origin,cwd,occurredAt,versionId)
    VALUES(?,?,?,?,?,'material','共享资料.md','输入','attachment',?,1,?)`,randomUUID(),pid,a,randomUUID(),randomUUID(),root,shared.versionId);
  const task = db.saveTask({projectId: pid, title: "有冻结输入的任务", instructions: "整理", inputVersionIds:[shared.versionId]}).id;
  const runId = db.claim({id:task,version:1,requestKey:randomUUID()},false).id;
  db.progress(runId,"进行中",a,randomUUID());
  db.publish(db.run(runId), { ...(await files.importFile(join(root,"共享资料.md"))).file, role:"output",path:"交付.md",fileName:"交付.md" });
  const board = db.state(pid);
  const find = (query: string) => sessionAssetGroups(board, board.assets, query);
  const full = find("");
  assert.equal(full.count,4);
  assert.deepEqual(new Set(full.groups.map(g=>g.id)), new Set([a,b,""]));
  assert.deepEqual(full.groups.map(g=>g.assets.length).sort(),[1,1,3]);
  assert.deepEqual(full.groups.filter(g=>g.id).map(g=>g.hint).sort(),[a.slice(-8),b.slice(-8)].sort());
  assert.equal(find("共享资料").count,1);
  assert.equal(find("共享资料").groups.length,2);
  assert.deepEqual(find(b).groups.map(g=>g.id),[b]);
  assert.deepEqual(find("未关联会话").groups[0].assets.map(f=>f.id),[free.id]);
  assert.deepEqual(sessionAssetGroups(board, [], "").groups,[]);
});

test("任务分组关联当前及历史输入、交付和会话文件，共享资产去重且保留项目级资料", async t => {
  const {db, pid, root, files, bind, asset} = await setup(t);
  const shared = await asset("共享资料.md"), frozen = await asset("执行输入.md");
  await asset("执行输入.md", "新的版本");
  const material = await asset("会话资料.md"), semantic = await asset("会话产物.md");
  const legacy = await asset("旧引用.md"), free = await asset("项目资料.md");
  const first = db.saveTask({projectId:pid, title:"整理资料", instructions:"整理", inputVersionIds:[shared.versionId, frozen.versionId]}).id;
  const second = db.saveTask({projectId:pid, title:"整理资料", instructions:"校对", inputVersionIds:[shared.versionId]}).id;
  const chat = bind("项目讨论"), turn = randomUUID();
  const run = db.claim({id:first, version:1, requestKey:randomUUID()}, false).id;
  db.progress(run, "执行中", chat, turn);
  const source = (await files.importFile(join(root, "共享资料.md"))).file;
  db.finish(run, "completed", {summary:"已交付", checks:[], files:[
    {...source, fileName:"成品.md", path:"成品.md", role:"output"},
    {...source, fileName:"交接.md", path:"交接.md", role:"handoff"}
  ]});
  db.saveTask({id:first,version:db.taskRow(first).version,title:"整理资料",instructions:"整理",inputVersionIds:[shared.versionId]});
  db.changeLifecycle("tasks", {id:second,version:db.taskRow(second).version,lifecycle:"archived"});
  function evidence(taskId:string|null, role:string, versionId:string|null) {
    db.write(`INSERT INTO conversation_files(id,projectId,taskId,threadId,turnId,itemId,role,path,quote,origin,cwd,occurredAt,versionId)
      VALUES(?,?,?,?,?,?,?,'文件','原话','mention',?,1,?)`,randomUUID(),pid,taskId,chat,randomUUID(),randomUUID(),role,root,versionId);
  }
  evidence(second,"material",material.versionId); evidence(second,"output",semantic.versionId);
  evidence(second,"output",semantic.versionId); evidence(second,"material",null); evidence(null,"material",free.versionId);
  db.write("INSERT INTO capture_refs VALUES (?,?,?,?,?)", chat,turn,pid,legacy.versionId,"旧引用.md");

  const board=db.state(pid), find=(term:string)=>taskAssetGroups(board,board.assets,term);
  const all=find("");
  assert.equal(all.count,8);
  const one=all.groups.find(g=>g.id===first)!, two=all.groups.find(g=>g.id===second)!;
  assert.deepEqual(new Set(one.assets.map(a=>a.name)), new Set(["共享资料.md","执行输入.md","成品.md","交接.md","旧引用.md"]));
  assert.deepEqual(new Set(two.assets.map(a=>a.name)), new Set(["共享资料.md","会话资料.md","会话产物.md"]));
  assert.equal(one.hint,first.slice(-8)); assert.equal(two.hint,second.slice(-8));
  assert.equal(two.lifecycle,"archived");
  assert.deepEqual(all.groups.at(-1)?.assets.map(a=>a.id),[free.id]);
  assert.equal(find("整理资料").count,7); assert.equal(find("共享").count,1); assert.equal(find("共享").groups.length,2);
  assert.deepEqual(find(second).groups.map(g=>g.id),[second]); assert.equal(find("未关联任务").count,1);
  const filtered=taskAssetGroups(board,board.assets.filter(a=>a.id===frozen.id),"");
  assert.deepEqual(filtered.groups.map(g=>g.id),[first]); assert.equal(filtered.count,1);
  assert.equal(find("没有匹配文件").count,0);
});

test("会话摘要只按已保存的前缀补全，保留离线片段，拒绝跨项目读取", async t => {
  const { db, pid, root, bind } = await setup(t);
  const original = "任务进度".repeat(90), full = original + "\n\n|状态|说明|\n|---|---|\n|完成|已校验|";
  const tid = bind("联调", original), p = { projectId: pid, threadId: tid };
  let calls = 0, closed = 0;
  const open = async () => ({
    async initialize() {}, close(){ closed++; }, async call(){
      calls++;
      return { data:[{items:[{type:"agentMessage",text:calls===1?"另一段回复":full}]}],nextCursor:calls===1?"more":null };
    },
  } as unknown as Reader);
  assert.deepEqual(await completeSummary(db,p,open),{text:full,truncated:false});
  assert.equal(calls,2); assert.equal(closed,1);
  assert.deepEqual(await completeSummary(db,p,async()=>{throw Error("offline")}),{text:original,truncated:true});
  const other=db.saveProject({title:"另一个项目"},root).id;
  await assert.rejects(completeSummary(db,{...p,projectId:other},open),/不属于/);
  const candidate=bind("其他会话",original,"candidate");
  await assert.rejects(completeSummary(db,{...p,threadId:candidate},open),/不属于/);
  assert.equal(calls,2);
});

test("摘要中的本地链接优先打开会话引用版本，也可预览项目文件", async t => {
  const {db,pid,bind,asset,root,dir} = await setup(t);
  const tid=bind("交付核对"), first=await asset("资料 原稿.md");await asset("资料 原稿.md","新版");
  db.write("INSERT INTO capture_refs VALUES(?,?,?,?,?)",tid,randomUUID(),pid,first.versionId,"资料 原稿.md");
  const p={projectId:pid,threadId:tid};
  assert.deepEqual(await summaryFile(db,{...p,href:encodeURIComponent("资料 原稿.md")}),{versionId:first.versionId});
  const path=join(root,"核验.md"); await writeFile(path,"结果");
  assert.deepEqual(await summaryFile(db,{...p,href:"核验.md#L2"}),{path:await realpath(path)});
  const outside=join(dir,"private.txt"); await writeFile(outside,"范围外");
  for(const href of [outside,"不存在.md","javascript:alert(1)","//example.invalid/share","https://example.invalid/"])
    await assert.rejects(summaryFile(db,{...p,href}));
});

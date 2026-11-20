import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Files } from "../src/assets.ts";
import { AttachmentUploads, chunkBytes } from "../src/attachments.ts";
import { prepare } from "../src/runner.ts";
import { Store } from "../src/store.ts";
import { policyFor, savePolicy } from "../src/schedule.ts";

test("附件分块上传、固定输入、失败回滚、重复提交和项目隔离", async () => {
  const root=await mkdtemp(join(tmpdir(),"moki-attachments-"));
  const store=new Store(root), files=new Files(root), uploads=new AttachmentUploads(files);
  try {
    const project=store.saveProject({title:"附件测试"},root).id;
    const other=store.saveProject({title:"另一个项目"},root).id;
    const bytes=Buffer.alloc(chunkBytes+7,53);
    const {token}=await uploads.begin(project,{name:"截图.png",size:bytes.length});
    await uploads.chunk(project,{token,offset:0,data:bytes.subarray(0,chunkBytes).toString("base64")});
    await assert.rejects(uploads.resolve(project,{uploads:[token]}),/完成/);
    await assert.rejects(uploads.chunk(other,{token,offset:chunkBytes,data:"YQ=="}));
    await assert.rejects(uploads.chunk(project,{token,offset:20,data:"YQ=="}),/顺序/);
    await uploads.chunk(project,{token,offset:chunkBytes,data:bytes.subarray(chunkBytes).toString("base64")});
    const {token:empty}=await uploads.begin(project,{name:"备注.txt",size:0});
    await uploads.chunk(project,{token:empty,offset:0,data:""});
    const source=join(root,"资料.md");await writeFile(source,"任务资料");
    const localScreenshot=await uploads.clipboardTarget();
    await writeFile(localScreenshot,bytes);
    const [screenshot]=await uploads.resolve(project,{attachmentPaths:[localScreenshot]});
    assert.equal(screenshot.file.fileName,"粘贴截图.png");
    assert.equal(screenshot.source,"");assert.deepEqual(await readFile(files.blob(screenshot.file.sha256)),bytes);
    const refs={uploads:[token,empty],attachmentPaths:[source]};
    const copies=await uploads.resolve(project,refs);
    assert.deepEqual(await readFile(files.blob(copies[0].file.sha256)),bytes);
    const params={projectId:project,timing:"now",instructions:"整理附件",requestKey:randomUUID()};
    const created=store.quickCreate(params,copies);
    assert.equal(store.run(created.runId!).snapshot.files.length,3);
    assert.equal(store.task(store.taskRow(created.taskId)).inputVersionIds.length,3);
    assert.equal(store.quickCreate(params,copies).created,false);
    assert.throws(()=>store.quickCreate(params,copies.slice(1)),/标识/);
    const extra=await files.importFile(source);
    assert.throws(()=>store.quickCreate({...params,requestKey:randomUUID()},[{...extra,source:"",file:{...extra.file,fileName:"冲突.txt"}}]),/运行|执行/);
    assert.equal(store.state(project).assets.length,3);
    const edited=store.saveTask({projectId:project,title:"编辑",instructions:"初稿"},copies.slice(0,1));
    store.saveTask({id:edited.id,version:1,title:"编辑",instructions:"保留并补充",inputVersionIds:store.task(store.taskRow(edited.id)).inputVersionIds},copies.slice(1));
    assert.equal(store.task(store.taskRow(edited.id)).inputVersionIds.length,3);
    await assert.rejects(uploads.resolve(other,refs));
  } finally {store.db.close();await rm(root,{recursive:true,force:true});}
});

test("继续优化固定本轮附件，重复提交、版本更新及后续轮次各自保留正确输入", async () => {
  const root=await mkdtemp(join(tmpdir(),"moki-refine-files-"));
  const store=new Store(root), files=new Files(root);
  try {
    const {id:projectId}=store.saveProject({title:"优化附件"},root);
    const {id:taskId}=store.saveTask({projectId,title:"核对参考图",instructions:"检查资料"});
    const original=store.claim({id:taskId,version:1,requestKey:randomUUID()},false);
    const empty={summary:"初稿",files:[],checks:[]};
    store.finish(original.id,"completed",empty);
    store.review({id:taskId,runId:original.id,version:store.taskRow(taskId).version,decision:"accept",note:""});
    const oldSnapshot=store.run(original.id).snapshot;
    const source=join(root,"参考.txt");await writeFile(source,"第一份内容");
    const pathCopy=await files.importFile(source);
    await writeFile(source,"相同名称的另一份内容");
    const uploaded={...await files.importFile(source),source:""};
    const attachments=[pathCopy,uploaded];
    const request={id:taskId,version:store.taskRow(taskId).version,runId:original.id,requestKey:randomUUID(),note:""};
    const busy=store.quickCreate({projectId,instructions:"占用测试",timing:"now",requestKey:randomUUID()});
    assert.throws(()=>store.refine(request,attachments),/已有执行中的任务/);
    assert.equal(store.state(projectId).assets.length,0);assert.equal(store.run(original.id).status,"done");
    assert.equal(store.task(store.taskRow(taskId)).reviews.length,1);
    store.finish(busy.runId!,"interrupted",empty);

    const next=store.refine(request,attachments);
    assert.equal(store.refine(request,attachments).created,false);
    assert.throws(()=>store.refine({...request,note:"替换要求"},attachments),/标识已使用/);
    assert.throws(()=>store.refine(request,[pathCopy]),/标识已使用/);
    const second=store.run(next.id);
    assert.deepEqual(store.run(original.id).snapshot,oldSnapshot);
    assert.deepEqual(store.task(store.taskRow(taskId)).inputVersionIds,[]);
    assert.equal(second.snapshot.files.length,2);
    assert.ok(second.snapshot.files.every(file=>file.refinementAttachment));
    assert.equal(store.state(projectId).runs.find(run=>run.id===next.id)?.refinementAttachments?.length,2);
    await writeFile(source,"后续的 v2");store.importFiles(projectId,[await files.importFile(source)]);
    const prepared=await prepare(second,files);
    assert.deepEqual(await Promise.all(prepared.map(item=>readFile(join(second.workDir,item.path),"utf8"))),["第一份内容","相同名称的另一份内容"]);
    const manifest=JSON.parse(await readFile(join(second.workDir,"inputs","manifest.json"),"utf8"));
    assert.ok(manifest.every((file:{refinementAttachment?:boolean})=>file.refinementAttachment));
    store.progress(second.id,"执行中",randomUUID(),randomUUID());
    store.finish(second.id,"completed",empty);
    const third=store.refine({id:taskId,version:store.taskRow(taskId).version,runId:second.id,requestKey:randomUUID(),note:"检查格式"});
    assert.deepEqual(store.run(third.id).snapshot.files,[]);
    assert.deepEqual(store.run(second.id).snapshot.files.map(file=>file.sha256),attachments.map(a=>a.file.sha256));
  } finally {store.db.close();await rm(root,{recursive:true,force:true});}
});

test("项目资料与调度设置一起提交，版本冲突时一起回滚", async () => {
  const root=await mkdtemp(join(tmpdir(),"moki-edit-policy-"));
  const store=new Store(root);
  try {
    const {id}=store.saveProject({title:"原名"},root);
    const base=policyFor(store,id);
    const write=(version:number)=>store.transaction(()=>{
      store.saveProject({id,title:"新名",version:store.project(id).version},root);
      savePolicy(store,{...base,id,version,mode:"auto",paused:true},[]);
    });
    assert.throws(()=>write(9),/已更新/);
    assert.equal(store.project(id).title,"原名");
    write(0);
    assert.equal(store.project(id).title,"新名");assert.equal(policyFor(store,id).paused,true);
  } finally {store.db.close();await rm(root,{recursive:true,force:true});}
});

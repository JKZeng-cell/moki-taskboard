import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {PreviewFiles,describePreview,streamPreview} from "./file-preview.mjs";
import {createServer} from "node:http";
import { Files } from "../../src/assets.ts";
import { prepareReplyDelivery } from "./delivery.mjs";
import { sessionTurns, modelOptions } from "./sessions.mjs";

test("DSH delivery uses pinned input bytes and checks the actual text and images",async()=>{
  const root=await mkdtemp(join(tmpdir(),"moki-dsh-test-"));
  try {
    const files=new Files(root),source=join(root,"sample.txt");
    await writeFile(source,"pinned");const {file}=await files.importFile(source);await writeFile(source,"changed");
    const run={snapshot:{files:[file],expectedFiles:["copy.txt","summary.md"],textChecks:[{path:"summary.md",contains:"已核对"}]}};
    const reply=artifacts=>({items:[{type:"agentMessage",text:"```moki-delivery\n"+JSON.stringify({summary:"验收",artifacts})+"\n```"}]});
    const dir=await prepareReplyDelivery(root,files,run,reply([{path:"copy.txt",input:1,role:"output"},{path:"summary.md",text:"已核对",role:"handoff"}]));
    const receipt=await files.collect(dir,run.snapshot);
    assert.equal(await readFile(join(dir,"outputs","copy.txt"),"utf8"),"pinned");
    assert.equal(receipt.files.length,2);assert.ok(receipt.checks.every(c=>c.passed));
    for (const item of [{path:"../outside",text:"x"},{path:"delivery.json",text:"x"},{path:"x",input:0},{path:"x",text:"x",input:1}])
      await assert.rejects(prepareReplyDelivery(root,files,run,reply([{role:"output",...item}])));
    assert.equal(await prepareReplyDelivery(root,files,run,{items:[{type:"agentMessage",text:"准备交付"}]}),undefined);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test("DSH associates the accepted request and terminal event with the same turn",()=>{
  const row=(type,data,seq)=>({type,data,seq,time:1000+seq});
  const turns=sessionTurns([row("turn/start",{turn:1},0),row("user/message",{source:{kind:"user",rpcId:"req"},content:[{type:"text",text:"第一项"}]},1),
    row("assistant/message",{message:{content:[{type:"text",text:"已交付"}]}},2),row("turn/end",{reason:{kind:"completed"}},3),
    row("turn/start",{turn:2},4),row("turn/end",{reason:{kind:"aborted"}},5)]);
  assert.deepEqual(turns[0].requests,["req"]);assert.equal(turns[0].status,"completed");assert.equal(turns[1].status,"interrupted");
  assert.equal(turns[0].items[1].text,"已交付");
});
test("DSH native approvals are linked to their own turn and original decision",()=>{
  const row=(type,data,i)=>({type,data,time:1000+i,seq:i});
  const result=sessionTurns([row("turn/start",{turn:1},0),row("approval/asked",{id:"one",toolName:"read"},1),
    row("approval/decided",{id:"one",outcome:"allowed-once"},2),row("turn/end",{reason:{kind:"completed"}},3),
    row("turn/start",{turn:2},4),row("approval/asked",{id:"two",toolName:"write"},5)]);
  assert.deepEqual(result.map(t=>t.approvals.map(a=>[a.id,a.status])),[[["one","accept"]],[["two","pending"]]]);
});

test("DSH 工作区只预览授权版本，分页保留 UTF-8 字符，媒体支持区间请求",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"moki-side-preview-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const files=new PreviewFiles(),other=new PreviewFiles(),path=join(dir,"带 # 的资料.md");
  const text="交接资料".repeat(16000);await writeFile(path,text);
  const ticket=await files.issue(path),signal=new AbortController().signal;
  assert.equal(await files.issue(path),ticket);
  await assert.rejects(describePreview(other,ticket,1,null,signal),/失效/);
  const one=await describePreview(files,ticket,1,null,signal),two=await describePreview(files,ticket,2,null,signal);
  assert.equal(one.pages,2);assert.equal(one.value.kind,"markdown");assert.equal(one.value.text+two.value.text,text);
  await writeFile(path,"更新版本");await assert.rejects(files.file(ticket),/已更新/);assert.notEqual(await files.issue(path),ticket);
  const movie=join(dir,"sample.webm"),bytes=Buffer.from("0123456789");await writeFile(movie,bytes);
  const media=await files.issue(movie);
  const server=createServer((req,res)=>void streamPreview(files,media,req,res));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url="http://127.0.0.1:"+server.address().port;
  const partial=await fetch(url,{headers:{range:"bytes=2-5"}});assert.equal(partial.status,206);
  assert.equal(partial.headers.get("content-range"),"bytes 2-5/10");assert.equal(await partial.text(),"2345");
  const invalid=await fetch(url,{headers:{range:"bytes=50-60"}});assert.equal(invalid.status,416);
  const head=await fetch(url,{method:"HEAD"});assert.equal(head.headers.get("content-length"),"10");
});

test("DSH model and effort choices preserve provider identity",async()=>{
  const group=id=>({id,name:id,models:[{id:"m",name:"M",reasoning:{efforts:[{id:"off"},{id:"high"}],defaultEffort:"high"}}]});
  const options=await modelOptions({sessionController:{modelCatalog:async()=>({groups:[group("a"),group("b")],default:{provider:"b",model:"m"}})}});
  assert.deepEqual(options.map(o=>o.id),["a/m","b/m"]);assert.equal(options[1].isDefault,true);assert.deepEqual(options[0].efforts,["off","high"]);
});


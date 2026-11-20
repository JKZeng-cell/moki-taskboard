import { createHash, randomBytes } from "node:crypto";
import { createServer, maxHeaderSize } from "node:http";
import { createServer as createLock } from "node:net";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../../src/store.ts";
import { Files } from "../../src/assets.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { CaptureService } from "../../src/capture.ts";
import { createActions } from "../../src/actions.ts";
import { object } from "../../src/validation.ts";
import { PreviewFiles, describePreview, streamPreview } from "./file-preview.mjs";
import { DshRunner } from "./runner.mjs";
import { classify, modelOptions, sessionReader } from "./sessions.mjs";

export const inject=["connection","webServer","sessionController","sessionQuery","agents","sessions","llm","agentDefaultModel","permissionPresets","workingDirectory"];
const listen=(server,...args)=>new Promise((ok,fail)=>{server.once("error",fail);server.listen(...args,()=>{server.off("error",fail);ok();});});
const stopServer=server=>new Promise(resolve=>server.close(resolve));
const localOrigin=value=>value==="dsh-app://app" || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(value);
const directory=()=>process.env.MOKI_DSH_TASKBOARD_DATA_DIR || join(process.env.DSH_HOME||join(homedir(),".dsh"),"moki-taskboard");

export async function apply(ctx) {
  // Each desktop launch can add another loopback cookie to Electron's persistent profile.
  // Apply the larger header allowance to this desktop listener before the welcome handshake.
  const http = ctx.webServer.server;
  const address = http?.address?.();
  const desktop = /[\\/]dsh-desktop-host[\\/]/i.test(process.argv[1] ?? "");
  if (desktop && address && ["127.0.0.1", "::1"].includes(address.address) &&
      "maxHeaderSize" in http && (http.maxHeaderSize ?? maxHeaderSize) < 65536) {
    const prior = http.maxHeaderSize;
    http.maxHeaderSize = 65536;
    ctx.effect(() => () => { if (http.maxHeaderSize === 65536) http.maxHeaderSize = prior; });
  }
  const lifetime=new AbortController();
  await mkdir(directory(),{recursive:true,mode:0o700});
  const root=await realpath(directory());
  const fingerprint=createHash("sha256").update(process.platform==="win32"?root.toLowerCase():root).digest("hex").slice(0,20);
  const lock=createLock(socket=>socket.end());
  await listen(lock,process.platform==="win32"?"\\\\.\\pipe\\dsh-moki-taskboard-"+fingerprint:join(tmpdir(),"dsh-moki-"+fingerprint+".sock"));
  let db,server,tick,scan,runner,capture;
  const grants=new Map();
  ctx.effect(()=>async()=>{
    lifetime.abort(); clearInterval(tick); clearInterval(scan); grants.clear();
    if (server?.listening) await stopServer(server);
    if (db) {
      await capture?.idle();
      while (runner && db.pendingRecovery().some(id=>runner.isActive(id))) await delay(50);
      db.db.close();
    }
    await stopServer(lock);
  });
  const panel=await readFile(new URL("./panel.html",import.meta.url));
  const metadata=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
  db=new Store(root);
  const files=new Files(root);
  runner=new DshRunner(db,files,ctx,lifetime.signal);
  const reader=async()=>sessionReader(ctx);
  capture=new CaptureService(db,root,reader,input=>classify(ctx,input,lifetime.signal));
  const dispatch=createActions({store:db,files,worker:runner,capture,models:()=>modelOptions(ctx),permissions:()=>[{value:"default",name:"DSH 默认权限",description:"使用 DSH 当前配置的默认权限预设。"},
      ...ctx.permissionPresets.catalog().options.map(o=>({...o,value:"dsh:"+o.value,description:o.description??""}))],reader,version:metadata.version,
    launchThread:async()=>{throw Error("请在 DSH 任务台页面重新打开会话。");}});
  const scheduler=new Scheduler(db,runner);
  tick=setInterval(()=>{try{scheduler.tick();}catch(e){ctx.logger.warn(e.message);}},1000);
  scan=setInterval(()=>void capture.scan().catch(()=>{}),30000);
  const ttl=12*60*60*1000;
  let origin;
  server=createServer(async(req,res)=>{
    const grantPath=/^\/p\/([0-9a-f]{64})\/(action|media\/([0-9a-f-]{36}))?$/.exec(req.url??"");
    const grant=grantPath && grants.get(grantPath[1]);
    const send=(status,body,type="application/json")=>{res.writeHead(status,{"content-type":type,"cache-control":"no-store",
      "x-content-type-options":"nosniff","referrer-policy":"no-referrer"});res.end(body);};
    if (!grant || Date.now()-grant.last>ttl || req.headers.host!==new URL(origin).host)
      return send(403,"{}");
    grant.last=Date.now();
    try {
      if (req.method==="GET" && !grantPath[2]) {
        res.setHeader("content-security-policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self' about:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors "+grant.parent);
        return send(200,panel,"text/html; charset=utf-8");
      }
      if (grantPath[3] && (req.method==="GET" || req.method==="HEAD")) return await streamPreview(grant.files,grantPath[3],req,res);
      if (req.method!=="POST" || grantPath[2]!=="action" || req.headers.origin!==origin ||
        req.headers["content-type"]!=="application/json" || req.headers["x-moki-taskboard"]!=="1") return send(403,"{}");
      let length=0; const chunks=[];
      for await (const chunk of req) { length+=chunk.length; if(length>512*1024) return send(413,"{}"); chunks.push(chunk); }
      const {action,params}=object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const input=object(params??{});
      if(action==="preview.read"){
        const cancelled=new AbortController();
        res.once("close",()=>cancelled.abort());
        const signal=AbortSignal.any([lifetime.signal,cancelled.signal]);
        const value=await describePreview(grant.files,input.ticket,input.page??1,ctx.get("officeToPdf"),signal);
        return send(200,JSON.stringify({value}));
      }
      const value=await dispatch(action,input);
      if (value?.path && ["asset.preview","asset.editRead","thread.summaryFile"].includes(action))
        value.previewTicket=await grant.files.issue(value.path);
      send(200,JSON.stringify({value:value??null}));
    } catch(e) { if(!res.headersSent && !res.destroyed)send(400,JSON.stringify({error:e.message})); }
  });
  await listen(server,0,"127.0.0.1");
  origin="http://127.0.0.1:"+server.address().port;
  ctx.effect(()=>ctx.webServer.register({kind:"exact",path:"/moki-taskboard/open",resource:async(req,peer)=>{
    const url=new URL(req.url),parent=url.searchParams.get("parent");
    if (req.method!=="GET" || req.headers.get("x-moki-taskboard")!=="1" ||
      req.headers.get("sec-fetch-site")==="cross-site" || !localOrigin(parent)) return new Response(null,{status:403});
    if (peer && peer.principal?.kind!=="owner") return new Response(null,{status:403});
    if (url.protocol==="dsh-app:") {
      if (url.hostname!=="app" || parent!=="dsh-app://app") return new Response(null,{status:403});
    } else {
      const authority=req.headers.get("host");
      const address=ctx.webServer.protocol+"//"+authority;
      if (!localOrigin(address) || (parent!==address && parent!=="dsh-app://app")) return new Response(null,{status:403});
      const authenticated=new Request(new URL(url.pathname+url.search,address),{headers:req.headers});
      const admission=ctx.connection.admit(authenticated);
      if (!admission.peer || admission.peer.principal?.kind!=="owner") return new Response(null,{status:403});
    }
    for(const [key,entry] of grants) if(Date.now()-entry.last>ttl) grants.delete(key);
    const token=randomBytes(32).toString("hex");
    grants.set(token,{parent,last:Date.now(),files:new PreviewFiles()});
    return Response.json({url:origin+"/p/"+token+"/"},{headers:{"cache-control":"no-store","referrer-policy":"no-referrer"}});
  }}),"moki-taskboard: desktop panel");
}


import { msg } from "./i18n.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingApproval } from "../types.ts";
import { action, openLinkedThread } from "./bridge.ts";
import { Dialog, Icon } from "./common.tsx";

export function approvalTitle(kind: string) {
  if (kind === "dsh/approval") return msg("DSH 工具请求");
  if (kind.includes("commandExecution")) return msg("执行命令");
  if (kind.includes("fileChange")) return msg("修改文件");
  return msg("额外权限");
}

export function ApprovalInbox({ready,changed}:{ready:boolean;changed:()=>Promise<void>}) {
  const [items,setItems]=useState<PendingApproval[]>([]);
  const [deferred,setDeferred]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const generation=useRef(0);
  const sync=useCallback(async()=>{
    const seq=++generation.current;
    const current=await action<PendingApproval[]>("approval.pending");
    if(seq!==generation.current)return;
    setItems(current);
    setDeferred(old=>old.some(id=>!current.some(a=>a.id===id))?old.filter(id=>current.some(a=>a.id===id)):old);
  },[]);
  useEffect(()=>{
    if(!ready)return;
    const update=()=>{if(!document.hidden)void sync().catch(()=>{});};
    update();
    const timer=window.setInterval(update,2500);
    window.addEventListener("focus",update);document.addEventListener("visibilitychange",update);
    return ()=>{++generation.current;window.clearInterval(timer);window.removeEventListener("focus",update);document.removeEventListener("visibilitychange",update);};
  },[ready,sync]);
  const item=items.find(a=>!deferred.includes(a.id));
  useEffect(()=>{setError("");},[item?.id]);
  function later(){if(item&&!busy)setDeferred(old=>[...old,item.id]);}
  async function handle(decision:"accept"|"decline"|"native") {
    if(!item||busy)return;
    setBusy(true);setError("");
    try{
      if(decision==="native"){await openLinkedThread(item.projectId,item.threadId);setDeferred(old=>[...old,item.id]);}
      else {await action("approval.decide",{runId:item.runId,id:item.id,decision});await changed();}
    }catch(e){setError((e as Error).message);}
    finally{await sync().catch(()=>{});setBusy(false);}
  }
  if(!items.length)return null;
  if(!item)return <button className="approval-reopen" onClick={()=>setDeferred([])}><Icon name="clock" size={15}/>{msg("待审批")} {items.length}</button>;
  const native=item.kind==="dsh/approval";
  return <Dialog key={item.id} alert title={msg("任务需要授权")} close={later}>
    <div className="approval-inbox" aria-busy={busy}>
      <p className="muted">{item.projectTitle}{items.length>1&&msg(" · 共 ")+items.length+msg(" 项待审批")}</p>
      <h3>{item.taskTitle}</h3>
      <strong>{approvalTitle(item.kind)}</strong>
      <pre tabIndex={0}>{formatRequest(item.detail)}</pre>
      {error&&<p role="alert" className="inline-error">{error}</p>}
      <div className="actions"><button disabled={busy} data-initial-focus onClick={later}>{msg("稍后处理")}</button>
        {native?<button disabled={busy} className="primary" onClick={()=>void handle("native")}>{msg("前往 DSH 会话审批")}</button>:<>
          <button disabled={busy} onClick={()=>void handle("decline")}>{msg("拒绝操作")}</button>
          <button disabled={busy} className="primary" onClick={()=>void handle("accept")}>{msg("允许本次操作")}</button>
        </>}
      </div>
    </div>
  </Dialog>;
}

function formatRequest(detail:string) {
  try {
    const labels:Record<string,string>={tool:msg("工具"),command:msg("命令"),cwd:msg("工作目录"),reason:msg("原因"),grantRoot:msg("授权目录"),network:msg("网络"),permissions:msg("请求权限")};
    const entries=Object.entries(JSON.parse(detail)).filter(([key,val])=>labels[key]&&val!=null);
    return entries.map(([key,value])=>labels[key]+"\n"+(typeof value==="string"?value:JSON.stringify(value,null,2))).join("\n\n")||detail;
  } catch {return detail;}
}

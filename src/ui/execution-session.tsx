import { msg } from "./i18n.ts";
import {useEffect,useState} from "react";
import type {Project, SessionChoice, SessionOption, Task} from "../types.ts";
import {action, requestKey} from "./bridge.ts";
import {Icon} from "./common.tsx";

export const automatic:SessionChoice={mode:"auto"};

export function SessionSelect({projectId,value,onChange,compact=false,disabled=false}:{
  projectId:string;value:SessionChoice;onChange:(value:SessionChoice)=>void;compact?:boolean;disabled?:boolean
}) {
  const [catalog,setCatalog]=useState<{id:string;items:SessionOption[];error?:boolean}>();
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let current=true;
    if(projectId)action<SessionOption[]>("project.sessionOptions",{projectId}).then(items=>{
      if(current)setCatalog({id:projectId,items});
    }).catch(()=>{if(current)setCatalog({id:projectId,items:[],error:true});});
    return ()=>{current=false;};
  },[projectId,attempt]);
  const loaded=catalog?.id===projectId?catalog:undefined;
  const items=loaded?.items??[];
  const key=value.mode==="existing"?"thread:"+value.threadId:value.mode;
  return <label className={compact?"quick-choice quick-session":"session-choice-field"}>
    {compact?<Icon name="chat" size={15}/>:<span>{msg("执行会话")}</span>}
    <select aria-label={msg("执行会话")} value={key} disabled={disabled||!projectId} onFocus={()=>{if(loaded?.error)setAttempt(n=>n+1);}}
      onChange={e=>{const next=e.target.value;onChange(next==="auto"||next==="new"?{mode:next}:{mode:"existing",threadId:next.slice(7)});}}>
      <option value="auto">{msg("自动判断")}</option><option value="new">{msg("新建会话")}</option>
      <optgroup label={msg("项目已有会话")}>
        {value.mode==="existing" && !items.some(item=>item.threadId===value.threadId) && <option value={key} disabled>{msg("原选择已不可用")}</option>}
        {items.map(item=><option value={"thread:"+item.threadId} key={item.threadId}>{item.title} · {item.threadId.slice(-6)}</option>)}
        {!items.length && <option disabled>{loaded?(loaded.error?msg("读取失败，重新展开可重试"):msg("暂无可选会话")):msg("正在读取…")}</option>}
      </optgroup>
    </select>
  </label>;
}

export function StartForm({project,task,busy,cancel,submit}:{project:Project;task?:Task;busy:boolean;cancel:()=>void;
  submit:(choice:SessionChoice,key:string)=>void}) {
  const [choice,setChoice]=useState<SessionChoice>(automatic);
  const [key]=useState(requestKey);
  return <form onSubmit={e=>{e.preventDefault();if(!busy)submit(choice,key);}}>
    <p className="start-task-name">{task?.title??project.title+msg(" · 队首任务")}</p>
    <SessionSelect projectId={project.id} value={choice} onChange={setChoice} disabled={busy}/>
    <div className="actions"><button type="submit" className="primary" disabled={busy}>{msg("启动执行")}</button>
      <button type="button" onClick={cancel} disabled={busy}>{msg("取消")}</button></div>
  </form>;
}

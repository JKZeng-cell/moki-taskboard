import { msg, subscribeLocale, uiLocale } from "./i18n.ts";
import {useEffect,useState,useSyncExternalStore} from "react";
import type {DeliveryPreview} from "../types.ts";
import {action,connectHost} from "./bridge.ts";
import {PreviewBody} from "./delivery-previews.tsx";

export function DshFilePreview({ticket}:{ticket:string}){
  useSyncExternalStore(subscribeLocale, uiLocale);
  const [page,setPage]=useState(1),[attempt,retry]=useState(0);
  const [entry,setEntry]=useState<{name:string;pages:number;value:DeliveryPreview}>();
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(true);
  useEffect(()=>{void connectHost().catch(()=>{});},[]);
  useEffect(()=>{
    let active=true;setLoading(true);setError("");
    action<NonNullable<typeof entry>>("preview.read",{ticket,page}).then(result=>{if(active)setEntry(result);})
      .catch((e:Error)=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[ticket,page,attempt]);
  return <main className="file-workspace" aria-label={msg("文件内容")}>
    {entry && entry.pages>1 && <nav aria-label={msg("文件翻页")}>
      <button disabled={loading||page===1} onClick={()=>setPage(n=>n-1)}>{msg("上一页")}</button>
      <span>{page} / {entry.pages}</span><button disabled={loading||page===entry.pages} onClick={()=>setPage(n=>n+1)}>{msg("下一页")}</button></nav>}
    <section key={page} className="workspace-body" aria-live="polite">
      {error?<p role="alert">{error} <button onClick={()=>retry(n=>n+1)}>{msg("重试")}</button></p>:loading?<p role="status">{msg("正在读取文件…")}</p>:
        entry&&<PreviewBody workspace key={ticket+page} name={entry.name} value={entry.value}/>}
    </section>
  </main>;
}

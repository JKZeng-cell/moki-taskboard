import { msg } from "./i18n.ts";
import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationFile, DeliveryPreview, Run } from "../types.ts";
import { action } from "./bridge.ts";
import { DeliveryGallery } from "./delivery-gallery.tsx";
import { Icon } from "./common.tsx";
import { FileIcon } from "./file-icon.tsx";

type Entry = {id:string; name:string; revision:number; handoff:boolean};
function preference(file:Entry) {
  if (file.handoff) return 4;
  if (/\.(png|jpe?g|webp|gif|svg|bmp|tiff?)$/i.test(file.name)) return 0;
  if (/\.(pdf|html?|md|markdown)$/i.test(file.name)) return 1;
  return 2;
}

function staticPage(html:string) {
  const fragment=document.createElement("template");
  fragment.innerHTML=html;
  fragment.content.querySelectorAll("script,iframe,frame,object,embed,link,base,meta,form,template,svg,math,video,audio").forEach(node=>node.remove());
  for (const node of Array.from(fragment.content.querySelectorAll("*"))) for (const attr of Array.from(node.attributes)) {
    if (/^on|^(?:href|srcset|action|formaction|target|autofocus|srcdoc|background|poster|ping|contenteditable)$/i.test(attr.name)
      || (attr.name==="src" && !(node.tagName==="IMG" && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(attr.value)))) node.removeAttribute(attr.name);
  }
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><style>html{color-scheme:light;background:white;color:#222}body{overflow-wrap:anywhere}img{max-width:100%}</style>'+fragment.innerHTML;
}

export function PreviewBody({value,name,workspace=false}:{value:DeliveryPreview;name:string;workspace?:boolean}) {
  const [badImage,setBadImage]=useState(false);
  const page=useMemo(()=>value.kind==="html"?staticPage(value.text):undefined,[value]);
  if (value.kind==="native" || badImage) return <p className="preview-notice">{badImage ? (workspace?msg("当前环境无法解码此文件。"):msg("当前环境无法解码此版本，可打开完整文件查看。")) : value.kind==="native" && (value.reason || msg("此文件需要使用原生预览。"))}</p>;
  if (value.kind==="image") return <figure className="preview-image"><img src={value.src} alt={name+msg(" 的交付效果")} onError={()=>setBadImage(true)}/>{value.label && <figcaption>{msg("第 {0} 页", value.label)}</figcaption>}</figure>;
  if (value.kind==="video") return <video controls preload="metadata" aria-label={name} src={value.src} onError={()=>setBadImage(true)}/>;
  if (value.kind==="audio") return <audio controls preload="metadata" aria-label={name} src={value.src} onError={()=>setBadImage(true)}/>;
  if (value.kind==="entries") return <div className="preview-content"><small>{msg("压缩包目录 · 共")} {value.total} {msg("项")}</small><ul>{value.entries.map((s,i)=><li key={i}>{s}</li>)}</ul>{value.entries.length<value.total && <small>{msg("仅显示前")} {value.entries.length} {msg("项")}</small>}</div>;
  if (value.kind==="html") return <><iframe className="preview-html" sandbox="" referrerPolicy="no-referrer" title={name+msg(" 的静态页面")} srcDoc={page}/>{value.truncated && <small>{msg("当前展示文件开头的静态页面。")}</small>}</>;
  return <div className="preview-content">
    {value.kind==="excerpt" && <small>{msg("文档内容摘录")}</small>}
    {value.kind==="markdown" ? <div className="session-markdown delivery-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      img:({alt})=><span>{alt}</span>,a:({children})=><span>{children}</span>,table:({children})=><div className="summary-table"><table>{children}</table></div>
    }}>{value.text}</Markdown></div> : <pre>{value.text || msg("（空文件）")}</pre>}
    {value.truncated && value.kind!=="excerpt" && <small>{msg("仅显示文件开头，可打开完整文件。")}</small>}
  </div>;
}

function SelectedPreview({projectId,file}:{projectId:string;file:Entry}) {
  const [value,setValue]=useState<DeliveryPreview>();
  const [error,setError]=useState("");
  useEffect(()=>{
    let active=true;
    action<DeliveryPreview>("asset.deliveryPreview",{projectId,versionId:file.id})
      .then(data=>{if(active)setValue(data);}).catch((e:Error)=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[projectId,file.id]);
  if (value?.kind==="image") return <DeliveryGallery projectId={projectId} images={[file]}/>;
  return <div className="delivery-view" aria-live="polite">{value?<PreviewBody value={value} name={file.name}/>
    : <p className="preview-notice">{error ? msg("无法读取此版本的预览：")+error : msg("正在读取交付物…")}</p>}</div>;
}

export function DeliveryPreviews({projectId,run,files=[],preview}:{projectId:string;run?:Run;files?:ConversationFile[];preview?:(id:string)=>void}) {
  const [picked,setPicked]=useState("");
  const entries=new Map<string,Entry>();
  for (const f of run?.files ?? []) entries.set(f.id,{id:f.id,name:f.path,revision:f.revision,handoff:f.role==="handoff"});
  const outputs=files.filter(f=>f.role==="output" && (!run || f.runId===run.id || (!f.runId && f.threadId===run.threadId && f.turnId===run.turnId)));
  for (const f of outputs) if (f.versionId && !entries.has(f.versionId)) entries.set(f.versionId,{id:f.versionId,name:f.fileName || f.path,revision:f.revision ?? 1,handoff:false});
  const options=[...entries.values()].sort((a,b)=>preference(a)-preference(b));
  const isImage=(f:Entry)=>/\.(png|jpe?g|webp|gif|svg|bmp|tiff?)$/i.test(f.name);
  const images=options.filter(isImage);
  const documents=options.filter(f=>!isImage(f));
  const selected=documents.find(f=>f.id===picked) ?? documents[0];
  const missing=outputs.filter(f=>!f.versionId);
  return <section className="delivery-proof" aria-label={msg("交付物预览")}>
    <header className="row between"><h4><Icon name="eye" size={15}/>{msg("交付物预览")}</h4>{selected && preview && <button type="button" className="ghost" onClick={()=>preview(selected.id)}><Icon name="external" size={13}/>{msg("打开完整文件")}</button>}</header>
    {images.length>0 && <DeliveryGallery projectId={projectId} images={images} preview={preview}/>}
    {selected ? <>
      <div className="delivery-picker"><FileIcon name={selected.name} size={16}/>{documents.length>1 ?
        <select aria-label={msg("选择交付物版本")} value={selected.id} onChange={e=>setPicked(e.target.value)}>
          {documents.map(f=><option key={f.id} value={f.id}>{f.name} · v{f.revision}</option>)}</select> :
        <span>{selected.name} · v{selected.revision}</span>}</div>
      <SelectedPreview key={projectId+"/"+selected.id} projectId={projectId} file={selected}/>
    </> : !images.length && !missing.length && <p className="preview-notice">{msg("尚未登记可预览的交付物。")}</p>}
    {missing.map(f=><p className="preview-notice" key={f.id}>{f.path} · {f.issue || msg("等待归集文件版本")}</p>)}
  </section>;
}

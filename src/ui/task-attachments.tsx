import { msg } from "./i18n.ts";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import { action, requestKey } from "./bridge.ts";
import { ImageLightbox } from "./delivery-gallery.tsx";
import type { DeliveryPreview } from "../types.ts";
import { FileIcon } from "./file-icon.tsx";
import { Icon } from "./common.tsx";

type Item = { key:string; name:string; file?:File; path?:string; imageTicket?:string };
const partSize = 192 * 1024;

export function useTaskAttachments() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const chooser = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [clipboardReads, setClipboardReads] = useState(0);
  function add(incoming: Item[]) {
    if (!incoming.length) return;
    setError("");
    setItems(current => {
      const next = [...current];
      for (const item of incoming) {
        if (!next.some(existing => item.path ? existing.path === item.path : existing.file === item.file)) next.push(item);
      }
      return next;
    });
  }
  function addFiles(files: File[]) {
    add(files.map(file => ({key:requestKey(), name:file.name || msg("粘贴图片.png"), file})));
  }
  async function pastePaths() {
    setClipboardReads(count => count + 1);
    try {
      const {paths,imageName,images}=await action<{paths:string[];imageName?:string;images?:Record<string,string>}>("pick",{kind:"clipboardFiles"});
      add(paths.map(path=>({key:requestKey(),name:imageName||path.split(/[\\/]/).pop()||path,path,imageTicket:images?.[path]})));
    } catch {setError(msg("无法读取剪贴板中的文件，可使用添加附件。"));}
    finally {setClipboardReads(count => count - 1);}
  }
  function paste(event: ClipboardEvent) {
    const data = event.clipboardData;
    const files = Array.from(data.files);
    if (!files.length) for (const item of Array.from(data.items)) {
      const file = item.kind === "file" ? item.getAsFile() : null;
      if (file) files.push(file);
    }
    if (files.length) { event.preventDefault(); addFiles(files); }
    else if (!data.getData("text/plain")) void pastePaths();
  }
  function dragOver(event: DragEvent) {
    if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect="copy"; setOver(true); }
  }
  function drop(event: DragEvent) {
    setOver(false);
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault(); addFiles(Array.from(event.dataTransfer.files));
    }
  }
  async function stage(projectId: string) {
    if (items.length > 32) throw Error(msg("每次最多可添加 32 个附件。"));
    const uploads:string[] = [], attachmentPaths:string[] = [];
    try {
      for (const item of items) {
        if (item.path) { attachmentPaths.push(item.path); continue; }
        const file = item.file!;
        const {token} = await action<{token:string}>("attachment.begin",{projectId,name:item.name,size:file.size});
        let offset=0;
        do {
          setProgress(item.name + " · " + (file.size ? Math.floor(offset/file.size*100) : 0) + "%");
          const buffer = new Uint8Array(await file.slice(offset,offset+partSize).arrayBuffer());
          let binary="";
          for (let start=0; start<buffer.length; start+=8192) binary+=String.fromCharCode(...buffer.subarray(start,start+8192));
          const result = await action<{received:number}>("attachment.chunk",{projectId,token,offset,data:btoa(binary)});
          if (result.received!==offset+buffer.byteLength) throw Error(msg("附件传输不完整，请重试。"));
          offset=result.received;
        } while (offset<file.size);
        uploads.push(token);
      }
      return items.length ? {uploads,attachmentPaths} : {};
    } finally { setProgress(""); }
  }
  function clear() { setItems([]); setError(""); }
  function remove(key:string) { setItems(current=>current.filter(item=>item.key!==key)); setError(""); }
  return {items, error, progress, readingClipboard:clipboardReads>0, chooser, addFiles, paste, dragOver, drop, over, leave:()=>setOver(false), stage, clear, remove};
}
type Attachments = ReturnType<typeof useTaskAttachments>;

export function AttachmentButtons({draft,disabled}:{draft:Attachments;disabled:boolean}) {
  return <span className="attachment-buttons">
    <input hidden type="file" multiple aria-label={msg("选择任务附件")} ref={draft.chooser} disabled={disabled} onChange={event=>{
      draft.addFiles(Array.from(event.target.files ?? [])); event.target.value="";
    }}/>
    <button type="button" className="icon-button ghost" aria-label={msg("添加附件")} title={msg("添加附件")} disabled={disabled}
      onClick={()=>draft.chooser.current?.click()}><Icon name="attachment" size={16}/></button>
  </span>;
}

function imageItem(item:Item) {
  return !!item.imageTicket || !!item.file && (item.file.type.startsWith("image/") || /\.(?:png|jpe?g|webp|gif|avif|bmp|svg|ico|tiff?)$/i.test(item.name));
}

async function imageThumbnail(file:File) {
  const bitmap=await createImageBitmap(file);
  try {
    const scale=Math.min(1,180/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext("2d");
    if(!context)throw Error(msg("无法生成缩略图"));
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    return canvas.toDataURL("image/png");
  }finally{bitmap.close();}
}

function DraftImage({item,full=false}:{item:Item;full?:boolean}) {
  const [src,setSrc]=useState(""),[error,setError]=useState("");
  const [useData,setUseData]=useState(false);
  useEffect(()=>{
    let active=true,url:string|undefined,reader:FileReader|undefined;
    async function load() {
      if(item.file){
        if(!full && !useData) {
          try{return await imageThumbnail(item.file);}catch{/* Fall back to the browser image decoder. */}
        }
        if(!active)return;
        if(useData){
          reader=new FileReader();
          const result=await new Promise<string>((resolve,reject)=>{
            reader!.onload=()=>resolve(String(reader!.result));reader!.onerror=reader!.onabort=()=>reject(Error(msg("无法读取图片")));
            reader!.readAsDataURL(item.file!);
          });
          return result;
        }
        url=URL.createObjectURL(item.file);
        return url;
      }
      if(item.imageTicket){
        const result=await action<DeliveryPreview>("attachment.clipboardImage",{token:item.imageTicket,thumbnail:!full});
        if(result.kind==="image")return result.src;
      }
      throw Error(msg("无法生成图片预览"));
    }
    void load().then(value=>{if(active && value)setSrc(value);}).catch((e:Error)=>{if(active)setError(e.message);});
    return ()=>{active=false;if(url)URL.revokeObjectURL(url);if(reader?.readyState===1)reader.abort();};
  },[item,full,useData]);
  if(error || !src)return <small role="status">{error || msg("正在载入…")}</small>;
  return <img className={full?"proof-full-image":undefined} src={src} alt={full?item.name:""}
    onError={()=>{if(src.startsWith("blob:") && !useData){setSrc("");setUseData(true);}else setError(msg("无法解码图片"));}}/>;
}

export function AttachmentList({draft,disabled}:{draft:Attachments;disabled:boolean}) {
  const [selected,setSelected]=useState<string>();
  const images=draft.items.filter(imageItem),index=images.findIndex(item=>item.key===selected),current=images[index];
  return <>{draft.items.length>0 && <ul className="attachment-list" aria-label={msg("待提交附件")}>
    {draft.items.map(item=><li key={item.key} className={imageItem(item)?"attachment-picture":undefined}>
      {imageItem(item)?<button type="button" className="draft-thumbnail" title={item.name} aria-label={msg("放大附件 ")+item.name} onClick={()=>setSelected(item.key)}>
        <DraftImage item={item}/></button>:<><FileIcon name={item.name} size={15}/><span title={item.name}>{item.name}</span></>}
      <button type="button" className="icon-button ghost" aria-label={msg("移除附件 ")+item.name} disabled={disabled} onClick={()=>draft.remove(item.key)}><Icon name="close" size={12}/></button></li>)}
  </ul>}{current&&<ImageLightbox name={current.name} index={index} count={images.length} close={()=>setSelected(undefined)}
    step={delta=>setSelected(images[(index+delta+images.length)%images.length].key)}><DraftImage key={current.key} item={current} full/></ImageLightbox>}
  {draft.progress && <small role="status" className="muted">{msg("正在上传")} {draft.progress}</small>}
  {draft.error && <p role="alert" className="inline-error">{draft.error}</p>}</>;
}

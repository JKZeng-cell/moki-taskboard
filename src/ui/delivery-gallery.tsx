import { msg } from "./i18n.ts";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DeliveryPreview } from "../types.ts";
import { action } from "./bridge.ts";
import { Dialog, Icon } from "./common.tsx";

export interface GalleryFile { id: string; name: string; revision: number }

function useImage(projectId: string, file: GalleryFile, thumbnail: boolean, visible: boolean) {
  const [value, setValue] = useState<DeliveryPreview>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!visible) return;
    let current = true;
    action<DeliveryPreview>("asset.deliveryPreview", { projectId, versionId: file.id, thumbnail })
      .then(result => { if (current) setValue(result); })
      .catch((e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [projectId, file.id, thumbnail, visible]);
  return { src: value?.kind === "image" ? value.src : undefined,
    status: error || (value?.kind === "native" ? value.reason : value ? msg("无法显示此图片") : msg("正在载入…")) };
}

function Thumbnail({ projectId, file, open }: { projectId: string; file: GalleryFile; open: () => void }) {
  const node = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const { src, status } = useImage(projectId, file, true, visible);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "100px" });
    observer.observe(node.current!);
    return () => observer.disconnect();
  }, []);
  return <button ref={node} type="button" className="proof-thumb" onClick={open}
    aria-label={msg("放大查看 {0} · v{1}", file.name, file.revision)} title={file.name}>
    <span className="proof-thumb-frame">{src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> :
      <small>{failed ? msg("无法解码") : status}</small>}</span>
    <span className="proof-thumb-caption">{file.name}</span>
  </button>;
}

function FullImage({ projectId, file }: { projectId: string; file: GalleryFile }) {
  const { src, status } = useImage(projectId, file, false, true);
  const [failed, setFailed] = useState(false);
  return src && !failed ? <img className="proof-full-image" src={src} alt={file.name} onError={() => setFailed(true)} /> :
    <p role="status">{failed ? msg("无法解码此图片，可打开完整文件查看。") : status}</p>;
}

export function ImageLightbox({name,index,count,step,close,children,meta,extra}:{
  name:string;index:number;count:number;step:(delta:number)=>void;close:()=>void;children:ReactNode;meta?:string;extra?:ReactNode
}) {
  return <Dialog title={name} close={close}>
    <div className="proof-lightbox" onKeyDown={e=>{
      if(count>1 && (e.key==="ArrowLeft"||e.key==="ArrowRight")){e.preventDefault();step(e.key==="ArrowLeft"?-1:1);}
    }}>
      <div className="proof-stage" tabIndex={0} data-initial-focus>{children}</div>
      <div className="proof-controls">
        {count>1&&<button type="button" onClick={()=>step(-1)} aria-label={msg("上一张")}><Icon name="left"/></button>}
        <span aria-live="polite">{index+1} / {count}{meta&&" · "+meta}</span>
        {count>1&&<button type="button" onClick={()=>step(1)} aria-label={msg("下一张")}><Icon name="right"/></button>}{extra}
      </div>
    </div>
  </Dialog>;
}

export function DeliveryGallery({ projectId, images, preview }: {
  projectId: string; images: GalleryFile[]; preview?: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const index = images.findIndex(file => file.id === selected);
  const current = images[index];
  function step(delta: number) { setSelected(images[(index + delta + images.length) % images.length].id); }
  return <>
    <div className="proof-thumbs" aria-label={msg("交付图片缩略图")}>{images.map(file =>
      <Thumbnail key={projectId + file.id} projectId={projectId} file={file} open={() => setSelected(file.id)} />)}</div>
    {current && <ImageLightbox name={current.name} index={index} count={images.length} step={step} close={()=>setSelected(undefined)}
      meta={`v${current.revision}`} extra={preview && <button type="button" className="ghost" onClick={()=>preview(current.id)}><Icon name="external" size={14}/>{msg("打开完整文件")}</button>}>
      <FullImage key={projectId+current.id} projectId={projectId} file={current}/>
    </ImageLightbox>}
  </>;
}


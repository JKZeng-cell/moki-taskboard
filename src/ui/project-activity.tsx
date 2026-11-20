import { msg } from "./i18n.ts";
import { useLayoutEffect, useRef } from "react";
import { localDay } from "../calendar.ts";
import type { Params, ProjectRelease } from "../types.ts";
import { Icon } from "./common.tsx";

export function Releases({releases, edit}: {releases:ProjectRelease[]; edit?: (release?:ProjectRelease)=>void}) {
  const [latest,...older] = releases;
  const history = useRef<HTMLUListElement>(null);
  const scrollable = older.length > 3;
  useLayoutEffect(() => {
    const list = history.current;
    if (!list || !scrollable) return;
    const details = list.closest("details")!;
    const rows = Array.from(list.children).slice(0, 3);
    const measure = () => {
      if (!details.open) return;
      const height = rows[2].getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top;
      if (height > 0) list.style.maxBlockSize = Math.ceil(height) + "px";
    };
    measure();
    const observer = new ResizeObserver(measure);
    rows.forEach(row => observer.observe(row));
    details.addEventListener("toggle", measure);
    return () => { observer.disconnect(); details.removeEventListener("toggle", measure); list.style.removeProperty("max-block-size"); };
  }, [older[0]?.id, older[1]?.id, older[2]?.id, scrollable]);
  return <section className="panel releases-panel">
    <div className="section-heading"><h2>{msg("上线版本")}</h2>{edit && <button className="ghost" onClick={()=>edit()}><Icon name="plus" size={14}/>{msg("登记版本")}</button>}</div>
    {latest ? <><div className="release-current"><span className="release-mark"><Icon name="release" size={20}/></span>
      <div><strong>{latest.label}</strong><small>{latest.releasedOn} {msg("上线")}</small></div>
      {edit && <button className="text-button" onClick={()=>edit(latest)} aria-label={msg("编辑版本 {0}", latest.label)}>{msg("编辑")}</button>}</div>
      {latest.notes && <p className="release-notes">{latest.notes}</p>}
      {older.length>0 && <details className="release-history"><summary>{msg("历史版本 ·")} {older.length}</summary>
        <ul ref={history} className="release-entries" aria-label={msg("历史版本")} data-scrollable={scrollable} tabIndex={scrollable ? 0 : undefined}>
          {older.map(r=><li key={r.id}><strong>{r.label}</strong><time dateTime={r.releasedOn}>{r.releasedOn}</time>
            {edit && <button className="text-button" aria-label={msg("编辑版本 {0}", r.label)} onClick={()=>edit(r)}>{msg("编辑")}</button>}{r.notes && <p>{r.notes}</p>}</li>)}
        </ul></details>}
    </> : <p className="muted">{msg("尚未登记上线版本")}</p>}
  </section>;
}

export function ReleaseForm({release,busy,save}: {release?:ProjectRelease;busy:boolean;save:(p:Params)=>void}) {
  const today=localDay(new Date());
  return <form className="stack" onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);
    save({id:release?.id,version:release?.version,label:data.get("label"),releasedOn:data.get("releasedOn"),notes:data.get("notes")});}}>
    <label>{msg("版本号")}<input name="label" required maxLength={80} defaultValue={release?.label} autoFocus placeholder={msg("例如 v1.2.0")}/></label>
    <label>{msg("上线日期")}<input name="releasedOn" type="date" required max={today} defaultValue={release?.releasedOn ?? today}/></label>
    <label>{msg("更新说明")}<textarea name="notes" rows={3} maxLength={4000} defaultValue={release?.notes} placeholder={msg("本次上线的主要变化（可选）")}/></label>
    <div className="actions"><button className="primary" disabled={busy}>{msg("保存版本")}</button></div>
  </form>;
}


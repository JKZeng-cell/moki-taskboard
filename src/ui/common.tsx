import { msg, uiDate } from "./i18n.ts";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Lifecycle, RunStatus, TaskStatus } from "../types.ts";

const glyphs = {
  release: "M3 5h8l9 9-7 7-10-10Zm4 3h.01",
  brand: "M5 6h14M5 12h6m-6 6h4m3-3 3 3 5-7",
  portfolio: "M4 5a1 1 0 0 1 1-1h5v7H4Zm10-1h5a1 1 0 0 1 1 1v4h-6ZM4 15h6v5H5a1 1 0 0 1-1-1Zm10-2h6v6a1 1 0 0 1-1 1h-5Z",
  projects: "M4 8a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Zm4 6h5m3 0h.5",
  overview: "M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm-1 4h16M8 13v2m4-3v3m4-2v2",
  tasks: "M4 6.5h3m-3 5.5h3m-3 5.5h3M10 5h9a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-9Zm0 5.5h7a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-7Zm0 5.5h9a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-9Z",
  assets: "M5 8h14l1 3v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7Zm-1 3h5l1.2 2h3.6l1.2-2h5M8 5h8",
  task: "M7 5h10a2 2 0 0 1 2 2v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a2 2 0 0 1 2-2Zm1 7 2 2 5-5m-7 7h8",
  sidebarOpen: "M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM9 5v14m4-10 3 3-3 3",
  sidebarClose: "M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM9 5v14m7-10-3 3 3 3",
  file: "M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6m-6 4h6",
  plus: "M12 5v14M5 12h14",
  minimize: "M5 12h14",
  send: "M12 19V5m-7 7 7-7 7 7",
  attachment: "m8 13 6.5-6.5a2.5 2.5 0 0 1 3.5 3.5l-8 8a4.5 4.5 0 0 1-6.4-6.4l8-8a3.5 3.5 0 0 1 5 5L9 17",
  paste: "M9 5H6a1 1 0 0 0-1 1v14h14V6a1 1 0 0 0-1-1h-3M9 3h6v4H9z",
  compose: "M14 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7m-9 4 1-4 7-7a1.5 1.5 0 0 1 2 2l-7 7Z",
  settings: "M4 7h9m4 0h3M4 17h3m4 0h9M17 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM11 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  search: "M15.5 15.5 21 21m-3.5-10.5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  refresh: "M20 10a8 8 0 1 0-2 7m2-13v6h-6",
  right: "m9 6 6 6-6 6",
  left: "m15 6-6 6 6 6",
  down: "m6 9 6 6 6-6",
  arrow: "M4 12h15m-6-6 6 6-6 6",
  external: "M14 4h6v6m0-6-9 9m7 0v6H5V6h6",
  more: "M5 12h.01M12 12h.01m7 0h.01",
  board: "M3 5h18v14H3Zm6 0v14m6-14v14",
  cards: "M4 4h6v6H4Zm10 0h6v6h-6ZM4 14h6v6H4Zm10 0h6v6h-6Z",
  table: "M3 5h18v14H3Zm0 5h18M3 14.5h18M10 5v14",
  play: "m8 5 12 7-12 7V5Z",
  close: "m6 6 12 12M6 18 18 6",
  pin: "m9 4 9 9m-9-9h5l6 6v5l-4-1-5 5-6-6 5-5-1-4Zm-1 12-5 5",
  chat: "M7 4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-6l-5 3v-3a4 4 0 0 1-3-4V8a4 4 0 0 1 4-4Zm1 5h8m-8 4h5",
  link: "M10 13a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.5-5.7l-1.8 1.8m2.3 4.4a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.5 5.7l1.8-1.8",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v5l3 2",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm12.5 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
  check: "m5 12 4 4L19 6",
  grip: "M9 5h.01M15 5h.01M9 12h.01m6 0h.01M9 19h.01m6 0h.01"
} as const;

export type IconName = keyof typeof glyphs;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={name === "more" || name === "grip" ? 2.9 : 1.65} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={glyphs[name]} />
  </svg>;
}

type ModuleName = "portfolio" | "projects" | "overview" | "tasks" | "assets" | "task";

export function ModuleIcon({ name, small = false }: { name: ModuleName; small?: boolean }) {
  return <span className={small ? "module-icon small" : "module-icon"} data-module={name}>
    <Icon name={name} size={small ? 17 : 23} />
  </span>;
}

export const taskLabels: Record<TaskStatus, string> = {
  todo: "待办", queued: "队列", running: "进行中", review: "待验收", done: "完成", error: "错误", paused: "已暂停"
};
const effortLabels: Record<string, string> = {
  none: "无", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "特高", max: "最大", ultra: "超高"
};
export const effortLabel = (level: string) => msg(effortLabels[level]) || level;
export const runLabels: Record<RunStatus, string> = {
  running: "进行中", recover: "待核对", review: "待验收", done: "完成", error: "错误", paused: "已暂停", returned: "已退回", refined: "已转入优化"
};
export const lifecycleLabels: Record<Lifecycle, string> = { active: "活动", archived: "归档", trash: "回收站" };
export const lifecycles = ["active", "archived", "trash"] as const;
export const shortDate = (value: string) => uiDate(new Date(value), { month: "short", day: "numeric" });
export const timestamp = (value: string) => uiDate(new Date(value), { dateStyle: "short", timeStyle: "short", hour12: false });

export function Status({ status, label = msg(taskLabels[status as TaskStatus]) }: { status: TaskStatus | RunStatus; label?: string }) {
  return <span className="status" data-status={status}><span className="status-dot" />{label}</span>;
}

export function Search({ value, change, label }: { value: string; change: (value: string) => void; label: string }) {
  return <label className="search">
    <Icon name="search" size={15} />
    <input type="search" value={value} onChange={event => change(event.target.value)} aria-label={label} placeholder={label} />
  </label>;
}

export function Empty({ icon = "projects", title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return <div className="empty-state">
    <span className="empty-icon"><Icon name={icon} size={20} /></span>
    <strong>{title}</strong>
    {children && <div className="muted">{children}</div>}
  </div>;
}

export function Menu({ label, children, context = false }: { label: string; children: ReactNode | ((origin: Element | null) => ReactNode); context?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const [point,setPoint]=useState<{x:number;y:number;origin:Element|null}|null>(null);
  useEffect(()=>{
    if(!context)return;
    const card=trigger.current?.closest("article,tr");
    if(!card)return;
    const show=(event:Event)=>{
      if(panel.current?.contains(event.target as Node))return;
      event.preventDefault();event.stopPropagation();
      const click=event as MouseEvent, bounds=trigger.current!.getBoundingClientRect();
      const position = click.clientX || click.clientY ? {x:click.clientX,y:click.clientY} : {x:bounds.left,y:bounds.bottom};
      setPoint({...position, origin:event.target instanceof Element ? event.target : null});
      setOpen(true);
    };
    const key=(event:Event)=>{const k=event as KeyboardEvent;if(k.key==="ContextMenu"||(k.shiftKey&&k.key==="F10"))show(k);};
    card.addEventListener("contextmenu",show);card.addEventListener("keydown",key);
    return ()=>{card.removeEventListener("contextmenu",show);card.removeEventListener("keydown",key);};
  },[context]);
  useLayoutEffect(() => {
    if (!open) return;
    const popup = panel.current!;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const { width, height } = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(6, Math.min(innerWidth - width - 6, point?.x ?? (anchor.right - width)))}px`;
      const below = point ? point.y : anchor.bottom + 4;
      popup.style.top = `${Math.max(6, below + height + 6 <= innerHeight ? below : (point?.y ?? anchor.top) - height - 4)}px`;
    };
    if(!popup.matches(":popover-open"))popup.showPopover();
    position();
    if(point)popup.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({preventScroll:true});
    const checkScroll = (event: Event) => { if (event.target !== popup && !(event.target instanceof Node && popup.contains(event.target))) setOpen(false); };
    window.addEventListener("resize", position);
    document.addEventListener("scroll", checkScroll, { capture: true });
    return () => {
      if (popup.matches(":popover-open")) popup.hidePopover();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", checkScroll, { capture: true });
    };
  }, [open,point]);
  function close() {
    setOpen(false);
    const origin = point?.origin?.closest<HTMLElement>("button, a[href], [tabindex]");
    (origin?.isConnected ? origin : trigger.current)?.focus({ preventScroll: true });
  }
  return <div className="menu" onKeyDown={event => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>
    <button type="button" ref={trigger} className="icon-button" aria-label={label} title={label}
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {setPoint(null);setOpen(!open);}}><Icon name="more" /></button>
    {open && <div id={id} ref={panel} className="menu-content" popover="auto"
      onToggle={event => { if (event.newState === "closed" && !event.currentTarget.matches(":popover-open")) setOpen(false); }}
      onClick={event => { if (event.target instanceof Element && event.target.closest("button")) close(); }}>
      {typeof children === "function" ? children(point?.origin ?? null) : children}</div>}
  </div>;
}

export function Dialog({ title, close, children, drawer = false, left = false, alert = false }: {
  title: string; close: () => void; children: ReactNode; drawer?: boolean; left?: boolean; alert?:boolean;
}) {
  const node = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const dialog = node.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => dialog.close();
  }, []);
  return <dialog ref={node} role={alert?"alertdialog":undefined} aria-labelledby={heading} className={drawer ? `dialog drawer${left ? " drawer-left" : ""}` : "dialog modal"}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-panel">
      <header className="dialog-head">
        <h2 id={heading}>{title}</h2>
        <button type="button" className="icon-button ghost" onClick={close} aria-label={msg("关闭")} title={msg("关闭")}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">{children}</div>
    </div>
  </dialog>;
}

export function Disclosure({ title, children, meta, icon, open }: {
  title: string; children: ReactNode; meta?: string; icon?: IconName; open?: boolean;
}) {
  return <details className="disclosure" open={open}>
    <summary>
      {icon && <Icon name={icon} size={15} />}
      <strong>{title}</strong>{meta && <span className="disclosure-meta">{meta}</span>}<Icon name="right" size={13} />
    </summary>
    <div className="disclosure-body">{children}</div>
  </details>;
}

export function Notice({ error, message }: { error?: string; message?: string }) {
  if (!error && !message) return null;
  return <div className={error ? "notice issue" : "notice"} role={error ? "alert" : "status"}>
    {!error && <Icon name="check" />}{error || message}
  </div>;
}

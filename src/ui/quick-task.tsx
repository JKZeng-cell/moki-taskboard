import { msg } from "./i18n.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectListItem, QuickTiming, SessionChoice } from "../types.ts";
import { action, requestKey } from "./bridge.ts";
import { AttachmentButtons, AttachmentList, useTaskAttachments } from "./task-attachments.tsx";
import { automatic, SessionSelect } from "./execution-session.tsx";
import { Icon } from "./common.tsx";

type Created = { projectId: string; taskId: string; runId: string | null };

export function QuickTask({ projects, current, initiallyMinimized, busy, createProject, refresh, open }: {
  projects: ProjectListItem[]; current?: string; initiallyMinimized: boolean; busy: boolean;
  createProject: () => void; refresh: () => void; open: (item: Created) => void;
}) {
  const draft = useTaskAttachments();
  const [minimized, setMinimized] = useState(initiallyMinimized);
  const [instructions, setInstructions] = useState("");
  const [target, setTarget] = useState<string>();
  const [timing, setTiming] = useState<QuickTiming>("todo");
  const [selection,setSelection]=useState<{projectId:string;choice:SessionChoice}>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<{ item: Created; title: string }>();
  const input = useRef<HTMLTextAreaElement>(null);
  const dock = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  const pending = useRef(false);
  const modeWrites = useRef(Promise.resolve());
  const lastAttempt = useRef<{ signature: string; key: string }>(undefined);
  const active = projects.filter(project => project.lifecycle === "active");
  const context = active.find(project => project.id === current)?.id;
  const destination = target ?? context ?? (!current && active.length === 1 ? active[0].id : "");
  const project = active.find(item => item.id === destination);
  const choice=selection?.projectId===project?.id ? selection?.choice??automatic : automatic;
  const enabled = Boolean(project && (instructions.trim() || draft.items.length) && !sending && !busy);
  const previousProject = useRef(current);
  useEffect(() => {
    if (current !== previousProject.current && !instructions.trim() && !draft.items.length) setTarget(undefined);
    else if (draft.items.length && target === undefined && project) setTarget(project.id);
    previousProject.current = current;
  }, [current, instructions, draft.items.length, target, project?.id]);

  useLayoutEffect(() => {
    const element = dock.current!;
    const workspace = element.parentElement!;
    const reserve = () => workspace.style.setProperty("--composer-space", element.offsetHeight + "px");
    reserve();
    const observer = new ResizeObserver(reserve);
    observer.observe(element);
    return () => { observer.disconnect(); workspace.style.removeProperty("--composer-space"); };
  }, []);
  useLayoutEffect(() => {
    if (toggled.current) (minimized ? toggle.current : input.current)?.focus();
  }, [minimized]);

  function setDisplay(next: boolean) {
    toggled.current = true;
    setMinimized(next);
    modeWrites.current = modeWrites.current.then(async () => {
      try { await action("ui.composer", { minimized: next }); }
      catch (error) { setError((error as Error).message); }
    });
  }

  async function submit() {
    if (!enabled || !project || pending.current) return;
    pending.current = true;
    setSending(true);
    setError("");
    setReceipt(undefined);
    const body = { projectId: project.id, instructions: instructions.trim() || draft.items.map(item=>item.name).join("、"), timing, ...(timing==="now"?{sessionChoice:choice}:{}) };
    const signature = JSON.stringify([body,draft.items.map(item=>item.key)]);
    if (lastAttempt.current?.signature !== signature) lastAttempt.current = { signature, key: requestKey() };
    try {
      const attachments = await draft.stage(project.id);
      const item = await action<Created>("task.quickCreate", { ...body, ...attachments, requestKey: lastAttempt.current.key });
      draft.clear();
      setInstructions("");
      setSelection(undefined);
      setReceipt({ item, title: project.title });
      lastAttempt.current = undefined;
      refresh();
    } catch (error) { setError((error as Error).message); }
    finally {
      pending.current = false;
      setSending(false);
    }
  }

  return <aside className="quick-dock" aria-label={msg("快捷任务")} ref={dock}>
    {minimized ? <button className="quick-launcher" ref={toggle} title={msg("展开任务输入框")} onClick={() => setDisplay(false)}
      aria-label={msg("展开任务输入框")} aria-expanded={false}><Icon name="compose" />{msg("快速创建任务")}
      {(instructions.trim() || draft.items.length>0) && <span className="draft-dot" aria-label={msg("有草稿")} />}</button> :
      <form className="quick-composer" aria-label={msg("快速创建任务")} data-dragging={draft.over}
        onPaste={sending ? undefined : draft.paste} onDragOver={sending ? undefined : draft.dragOver} onDragLeave={draft.leave} onDrop={sending ? undefined : draft.drop} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="quick-input-row">
          <textarea ref={input} aria-label={msg("快捷任务内容")} placeholder={msg("描述一个任务…")} rows={2} maxLength={18000}
            value={instructions} readOnly={sending} onChange={event => {
              if (target === undefined && project) setTarget(project.id);
              setInstructions(event.target.value); setError(""); setReceipt(undefined);
            }} onKeyDown={event => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault(); void submit();
              }
            }} />
          <button className="icon-button ghost quick-minimize" type="button" title={msg("最小化输入框")} aria-label={msg("最小化输入框")}
            aria-expanded={true} onClick={() => setDisplay(true)}><Icon name="minimize" size={15} /></button>
        </div>
        <AttachmentList draft={draft} disabled={sending}/>
        <div className="quick-controls">
          <AttachmentButtons draft={draft} disabled={sending}/>
          {active.length ? <label className="quick-choice" title={project?.title || msg("选择项目")}>
            <Icon name="projects" size={15} />
            <select aria-label={msg("任务所属项目")} value={project?.id || ""} disabled={sending}
              onChange={event => { setSelection(undefined); setTarget(event.target.value); setError(""); setReceipt(undefined); }}>
              <option value="" disabled>{msg("选择项目")}</option>
              {active.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label> : <button className="ghost quick-new-project" type="button" disabled={busy}
            onClick={createProject}><Icon name="plus" size={15} />{msg("新建项目")}</button>}
          <label className="quick-choice quick-timing" title={msg("执行时间")}>
            <Icon name={timing === "now" ? "play" : "clock"} size={15} />
            <select aria-label={msg("执行时间")} value={timing} disabled={sending} onChange={event => {
              setTiming(event.target.value as QuickTiming); setError(""); setReceipt(undefined);
            }}>
              <option value="todo">{msg("进入待办")}</option><option value="now">{msg("立即执行")}</option>
            </select>
          </label>
          {timing==="now"&&project&&<SessionSelect compact projectId={project.id} value={choice} disabled={sending} onChange={next=>setSelection({projectId:project.id,choice:next})}/>}
          <button className="primary quick-send" type="submit" disabled={!enabled}
            aria-label={timing === "now" ? msg("创建并立即执行") : msg("创建待办任务")}
            title={`${timing === "now" ? msg("创建并立即执行") : msg("创建待办任务")} (Ctrl / ⌘ + Enter)`}><Icon name="send" size={18} /></button>
        </div>
        {(receipt || error) && <div className="quick-feedback" role={error ? "alert" : "status"}>
          {error ? <span className="inline-error">{error}</span> : receipt && <>
            <Icon name="check" size={14} /><span>{receipt.item.runId ? msg("已启动") : msg("已加入待办")} · {receipt.title}</span>
            <button type="button" className="text-button" onClick={() => open(receipt.item)}>{msg("查看任务")}</button>
          </>}
        </div>}
      </form>}
  </aside>;
}

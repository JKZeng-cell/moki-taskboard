import { msg } from "./i18n.ts";
import { hostName } from "../host-identity.ts";
import { useEffect, useState } from "react";
import type { BoardState, Params, Task } from "../types.ts";
import type { Link } from "../capture.ts";
import { action } from "./bridge.ts";
import { parseSessionId, sessionPrefix } from "../host-identity.ts";
import { Notice } from "./common.tsx";

type Choice = Pick<Task, "id" | "title">;

export function SessionBindingForm({ board, link, busy, cancel, reload, save }: {
  board: BoardState; link?: Link; busy: boolean; cancel: () => void; reload: (link: Link) => void; save: (value: Params) => void;
}) {
  const current = board.project!.id;
  const [target, setTarget] = useState(link?.projectId ?? current);
  const [taskId, setTaskId] = useState(link?.taskId ?? "");
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [foreign, setForeign] = useState<{ projectId: string; tasks: Choice[]; error?: string }>();
  useEffect(() => {
    if (target === current) return;
    let cancelled = false;
    action<Choice[]>("thread.taskOptions", { projectId: target }).then(tasks => {
      if (!cancelled) setForeign({ projectId: target, tasks });
    }).catch((error: Error) => {
      if (!cancelled) setForeign({ projectId: target, tasks: [], error: error.message });
    });
    return () => { cancelled = true; };
  }, [target, current, attempt]);

  const remote = foreign?.projectId === target ? foreign : undefined;
  const choices = target === current ? board.tasks.filter(task => task.lifecycle === "active") : remote?.tasks;
  const latestLink = link && board.sessions.links.find(item => item.threadId === link.threadId);
  if (link && latestLink?.version !== link.version) return <div className="binding-stale">
    <p>{latestLink ? msg("这条会话的归属已更新，请载入最新记录。") : msg("这条会话已移出当前项目。")}</p>
    <div className="actions"><button onClick={cancel} disabled={busy}>{msg("关闭表单")}</button>
      {latestLink && <button className="primary" disabled={busy} onClick={() => reload(latestLink)}>{msg("载入最新归属")}</button>}</div>
  </div>;
  const unavailable = Boolean(taskId && choices && !choices.some(task => task.id === taskId));
  return <form className="session-binding" onSubmit={event => {
    event.preventDefault();
    if (unavailable || busy) return;
    const threadId = link?.threadId || parseSessionId(input);
    if (!threadId) { setInvalid(true); return; }
    const existing = link ?? board.sessions.links.find(item => item.threadId.toLowerCase() === threadId);
    save({ threadId: existing?.threadId ?? threadId, version: existing?.version ?? 0, targetProjectId: target, taskId: taskId || null });
  }}>
    {link ? <>
      <div className="binding-subject"><strong>{link.name || hostName+msg(" 会话")}</strong><code>{link.threadId}</code></div>
      <label>{msg("归属项目")}<select value={target} data-initial-focus onChange={e => {
        setTarget(e.target.value); setTaskId(""); setForeign(undefined);
      }}>
        {board.projects.filter(project => project.lifecycle === "active").map(project =>
          <option value={project.id} key={project.id}>{project.title}</option>)}
      </select></label>
    </> : <label>{msg("会话 ID 或链接")}<input required data-initial-focus autoComplete="off" spellCheck={false}
      aria-invalid={invalid || undefined} aria-describedby={invalid ? "session-id-error" : undefined}
      placeholder={sessionPrefix+"…"} value={input} onChange={e => { setInput(e.target.value); setInvalid(false); }} />
      {invalid && <span id="session-id-error" role="alert">{msg("请输入完整的会话 ID 或")} {hostName} {msg("会话链接。")}</span>}
    </label>}
    <label>{msg("关联任务")}<select value={taskId} disabled={!choices} onChange={e => setTaskId(e.target.value)}>
      <option value="">{choices ? msg("只绑定项目") : msg("正在读取任务…")}</option>
      {unavailable && <option value={taskId} disabled>{msg("原关联任务已归档或删除")}</option>}
      {choices?.map(task => <option value={task.id} key={task.id}>{task.title}</option>)}
    </select>{unavailable && <small>{msg("请选择活动任务或「只绑定项目」。")}</small>}</label>
    {target !== current && remote?.error && <div><Notice error={remote.error} />
      <button type="button" className="text-button" onClick={() => { setForeign(undefined); setAttempt(attempt + 1); }}>{msg("重新读取任务")}</button></div>}
    <div className="actions"><button type="button" onClick={cancel} disabled={busy}>{msg("取消")}</button>
      <button type="submit" className="primary" disabled={busy || unavailable || (!link && !input.trim())}>{link ? msg("保存绑定") : msg("绑定会话")}</button>
    </div>
  </form>;
}


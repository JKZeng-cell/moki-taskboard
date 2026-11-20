import { msg, uiLocale } from "./i18n.ts";
import { permissionLabel } from "../execution-permissions.ts";
import { hostName } from "../host-identity.ts";
import { useState } from "react";
import { ActivityCalendar } from "./activity-calendar.tsx";
import { Releases } from "./project-activity.tsx";
import type { ActivityWeeks } from "../calendar.ts";
import { WorkUpdate } from "./work-update.tsx";
import { Usage } from "./usage.tsx";
import type { BoardState, Lifecycle, Project, ProjectRelease, TaskStatus } from "../types.ts";
import { taskStatuses } from "../workflow.ts";
import { effortLabel, Icon, lifecycleLabels, runLabels, Status, taskLabels, timestamp } from "./common.tsx";

export function Overview({ board, project, busy, canStart, activityWeeks, changeActivityRange, goTasks, goAssets, openTask, preview, session,
  changeLifecycle, edit, start, nativeFiles, configure, editRelease, jumpThread }: {
  editRelease:(release?:ProjectRelease)=>void; jumpThread:(id:string)=>void;
  activityWeeks: ActivityWeeks; changeActivityRange: (weeks: ActivityWeeks) => void;
  configure:()=>void; board: BoardState; project: Project; busy: boolean; canStart: boolean; goTasks: (status?: TaskStatus) => void;
  goAssets: () => void; openTask: (taskId: string, runId?: string) => void;
  preview: (versionId: string) => void; session: (runId: string) => void;
  changeLifecycle: (value: Lifecycle) => void; edit: () => void; start: () => void; nativeFiles: boolean;
}) {
  const [allRuns, setAllRuns] = useState(false);
  const active = project.lifecycle === "active";
  const counts = { todo: 0, queued: 0, running: 0, review: 0, done: 0, error: 0, paused: 0 };
  const tasks = board.tasks.filter(task => task.lifecycle === "active");
  for (const task of tasks) counts[task.status]++;
  const assets = board.assets.filter(asset => asset.lifecycle === "active");
  const handoff = board.assets.find(asset => asset.versions.some(version => version.id === project.handoffVersionId));
  const updates=board.dashboard?.updates ?? [];
  const currentHandoffs=updates.filter(u=>u.kind==="handoff" && u.current);
  const olderHandoffs=updates.filter(u=>u.kind==="handoff" && !u.current);
  const history=[...board.runs.map(run=>({type:"run" as const,at:run.startedAt,run})),
    ...updates.filter(u=>u.kind==="progress").map(update=>({type:"chat" as const,at:update.occurredAt,update}))]
    .sort((a,b)=>b.at.localeCompare(a.at));
  const total = tasks.length;
  const complete = total ? Math.round(counts.done / total * 100) : 0;
  const stats = [
    { label: msg("全部任务"), value: total, icon: "tasks" },
    { label: msg("队列"), value: counts.queued, icon: "clock", status: "queued" },
    { label: msg("进行中"), value: counts.running, icon: "play", status: "running" },
    { label: msg("完成"), value: counts.done, icon: "check", status: "done" }
  ] as const;

  return <div className="page-content">
    <div className="metrics" aria-label={msg("项目任务统计")}>
      {stats.map(stat => {
        const status = "status" in stat ? stat.status : undefined;
        return <button className="metric" key={stat.label} data-status={status} onClick={() => goTasks(status)}>
          <span>{stat.label}<Icon name={stat.icon} size={17} /></span><strong>{stat.value}</strong>
        </button>;
      })}
    </div>

    <div className="overview-grid">
      <section className="panel progress-panel">
        <div className="section-heading"><h2>{msg("任务进度")}</h2>
          <div className="row">
            <span className="tag">{active ? board.policy?.paused?msg("已暂停派发"):({manual:msg("手动执行"),auto:msg("自动执行"),window:msg("时段执行")}[board.policy?.mode??"manual"]) : msg(lifecycleLabels[project.lifecycle])}</span>
            {active ? <button className="primary" disabled={busy || !canStart || !counts.queued}
              onClick={start}><Icon name="play" size={15} />{msg("开始项目")}</button>
              : <button className="primary" disabled={busy} onClick={() => changeLifecycle("active")}>{msg("恢复项目")}</button>}
          </div>
        </div>
        <div className="completion"><strong>{complete}%</strong><span className="muted">{counts.done} / {total} {msg("项完成")}</span></div>
        <div className="distribution" role="img" aria-label={taskStatuses.map(status => msg("{0} {1} 项", msg(taskLabels[status]), counts[status])).join("，")}>
          {taskStatuses.filter(status => counts[status]).map(status => <span key={status} data-status={status}
            style={{ flex: counts[status] }} />)}
        </div>
        <div className="progress-legend">
          {taskStatuses.map(status => <button className="ghost" onClick={() => goTasks(status)} key={status}>
            <Status status={status} /><strong>{counts[status]}</strong>
          </button>)}
        </div>
        <Usage runs={board.runs} title={msg("项目用量")} />
      </section>
      <section className="panel context-panel">
        <div className="section-heading"><h2>{msg("项目资料")}</h2></div>
        <dl>
          <div><dt><Icon name="projects" />{msg("项目分类")}</dt><dd>{project.category || msg("未分类")}</dd></div>
          <div><dt><Icon name="settings" />{msg("执行偏好")}</dt><dd className="project-config">
            <span>{project.preferredModel || hostName+msg(" 默认模型")} · {project.preferredEffort ? msg("{0}强度", effortLabel(project.preferredEffort)) : msg("模型默认强度")} · {msg(permissionLabel(project.permission) ?? "")}</span>
            {active && <button className="text-button" onClick={edit} disabled={busy} aria-label={msg("设置项目执行偏好")}>{msg("设置")}</button>}
          </dd></div>
          <div><dt><Icon name="clock"/>{msg("调度与归集")}</dt><dd className="project-config">
            <span>{board.policy?.paused?msg(board.policy.reason):board.policy?.mode==="window"?(board.window?.open?msg("时段内"):msg("时段外")):board.policy?.mode==="auto"?(counts.queued?msg("处理队列"):msg("队列空闲")):msg("按需启动")} · {board.policy?.capture?msg("归集已启用"):msg("归集已关闭")}</span>
            {board.window?.next&&<small>{board.window.open?msg("结束"):msg("开始")} {new Date(board.window.next).toLocaleString(uiLocale(),{timeZone:board.policy!.zone})} {board.policy!.zone}</small>}
            {active&&<button className="text-button" onClick={configure}>{msg("执行与归集设置")}</button>}</dd></div>
          <div><dt><Icon name="projects" />{msg("项目目录")}</dt><dd className="path" title={project.root}>{project.root}</dd></div>
          <div><dt><Icon name="file" />{msg("项目资产")}</dt>
            <dd><button className="text-button" onClick={goAssets}>{assets.length} {msg("项资产")}<Icon name="right" size={13} /></button></dd></div>

        </dl>
        {project.description && <details className="project-goal">
          <summary><Icon name="file" />{msg("项目目标")}<span className="goal-excerpt" aria-hidden="true">{project.description}</span><Icon name="down" size={13} /></summary>
          <p className="prose">{project.description}</p>
        </details>}
      </section>
    </div>

    <div className="overview-grid overview-activity">
      <ActivityCalendar activity={board.dashboard?.activity ?? []} tasks={board.tasks} open={openTask} range={activityWeeks}
        loadedWeeks={board.dashboard?.activityWeeks ?? 0} changeRange={changeActivityRange}/>
      <Releases releases={board.dashboard?.releases ?? []} edit={active && !busy ? editRelease : undefined}/>
    </div>
    <section className="panel project-handoffs">
      <div className="section-heading"><h2>{msg("执行交接")}</h2>{active && <button className="ghost" onClick={configure}><Icon name="settings" size={14}/>{msg("归集设置")}</button>}</div>
      {handoff && project.handoffVersionId && <div className="registered-handoff"><Icon name="file"/><span>{msg("交接文件")}</span>
        {nativeFiles ? <button className="text-button" onClick={()=>preview(project.handoffVersionId!)}>{handoff.name}<Icon name="external" size={13}/></button> : <strong>{handoff.name}</strong>}</div>}
      {currentHandoffs.map(u=><WorkUpdate key={u.id} item={u} jump={jumpThread} openTask={openTask}/>)}
      {!currentHandoffs.length && !handoff && <p className="muted">{msg("暂无执行交接")}</p>}
      {olderHandoffs.length>0 && <details className="release-history"><summary>{msg("历史交接 ·")} {olderHandoffs.length}</summary>
        {olderHandoffs.map(u=><WorkUpdate key={u.id} item={u} jump={jumpThread} openTask={openTask}/>)}</details>}
    </section>
    <section className="panel history-panel">
      <div className="section-heading"><h2>{msg("执行记录")}</h2>
        {history.length > 4 && <button className="ghost" onClick={() => setAllRuns(!allRuns)}>
          {allRuns ? msg("收起") : msg("查看全部 {0} 条", history.length)}
        </button>}
      </div>
      {history.length > 0 ? <div className="history-list">
        {history.slice(0, allRuns ? undefined : 4).map(entry => {
          if(entry.type==="chat")return <WorkUpdate key={entry.update.id} item={entry.update} jump={jumpThread} openTask={openTask}/>;
          const run=entry.run;
          return <div className="history-row" key={run.id}>
          <button className="ghost history-main" onClick={() => openTask(run.taskId, run.id)}>
            <span className="file-icon"><Icon name="clock" /></span>
            <span><strong>{board.tasks.find(task => task.id === run.taskId)?.title ?? msg("任务执行")}</strong>
              <small>{msg(run.phase)} · {timestamp(run.startedAt)}</small></span>
          </button>
          <Status status={run.status} label={msg(runLabels[run.status])} />
          {run.threadId && <button className="icon-button ghost" aria-label={msg("跳转 {0} 会话", hostName)} title={msg("跳转 {0} 会话", hostName)}
            onClick={() => session(run.id)}><Icon name="external" /></button>}
        </div>;})}
      </div> : <p className="history-empty muted">{msg("暂无执行记录。")}</p>}
    </section>
  </div>;
}

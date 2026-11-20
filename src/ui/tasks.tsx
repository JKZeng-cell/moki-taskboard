import { msg } from "./i18n.ts";
import { hostName } from "../host-identity.ts";
import { ConversationFiles } from "./conversation-files.tsx";
import { WorkUpdate } from "./work-update.tsx";
import { FileIcon } from "./file-icon.tsx";
import { useEffect, useRef, useState } from "react";
import type { DragEvent, RefObject } from "react";
import type { Asset, ConversationFile, ConversationUpdate, Lifecycle, Run, Task, TaskStatus } from "../types.ts";
import { canRefineStatus, runControlsStatus, startableStatuses, taskStatuses } from "../workflow.ts";
import { Disclosure, Dialog, Empty, Icon, lifecycleLabels, lifecycles, Menu, ModuleIcon, Notice, runLabels, Search, shortDate, Status, taskLabels, timestamp } from "./common.tsx";
import { Acceptance } from "./acceptance.tsx";
import { approvalTitle } from "./approval-inbox.tsx";
import { RunCard } from "./run-card.tsx";
import { Usage } from "./usage.tsx";

export type TaskMode = "board" | "table";
export type TaskFilter = TaskStatus | "all";

type CardActions = {
  start:(task:Task)=>void; edit:(task:Task)=>void; review:(task:Task)=>void; refine:(task:Task)=>void;
  lifecycle:(task:Task,value:Lifecycle)=>void; session:(id:string)=>void; canStart:boolean;
};

export function TasksPage({ cards, tasks, runs, mode, setMode, filter, setFilter, editable, busy, add, open, move }: {
  cards:CardActions; tasks: Task[]; runs: Run[]; mode: TaskMode; setMode: (mode: TaskMode) => void;
  filter: TaskFilter; setFilter: (filter: TaskFilter) => void; editable: boolean; busy: boolean;
  add: (status?: TaskStatus) => void; open: (id: string) => void; move: (task: Task, status: TaskStatus) => void;
}) {
  const [scope, setScope] = useState<Lifecycle>("active");
  const [query, setQuery] = useState("");
  const board = useRef<HTMLDivElement>(null);
  const term = query.trim().toLocaleLowerCase();
  const owners = new Map<string, Run["status"]>();
  for (const run of runs) {
    if (runControlsStatus(run.status) && (!owners.has(run.taskId) || run.status !== "review")) owners.set(run.taskId, run.status);
  }
  const result = tasks.filter(task => task.lifecycle === scope &&
    (mode === "board" || filter === "all" || task.status === filter) &&
    `${task.title} ${task.instructions}`.toLocaleLowerCase().includes(term));
  const canEdit = editable && scope === "active";
  const boardEditable = canEdit && !busy;
  function controls(task:Task) {
    const owner=owners.get(task.id), active=editable&&task.lifecycle==="active";
    const runnable=active&&!owner&&startableStatuses.includes(task.status);
    const session=runs.find(r=>r.taskId===task.id&&r.threadId);
    return <div className="card-actions">
      {runnable && <button type="button" className="card-start ghost" title={msg("启动任务")} aria-label={msg("启动任务 {0}", task.title)}
        disabled={busy||!cards.canStart} onClick={()=>cards.start(task)}><Icon name="play" size={13}/><span>{msg("启动")}</span></button>}
      {active && task.status === "done" && !owner && <button type="button" className="card-start ghost"
        aria-label={msg("继续优化 {0}", task.title)} disabled={busy} onClick={() => cards.refine(task)}>
        <Icon name="compose" size={13} /><span>{msg("继续优化")}</span></button>}
      <Menu context label={msg("任务操作 {0}", task.title)}>
        <button onClick={()=>open(task.id)}>{msg("查看详情")}</button>
        {runnable && <button disabled={busy||!cards.canStart} onClick={()=>cards.start(task)}>{msg("启动任务")}</button>}
        {active && <>
          <button disabled={busy} onClick={()=>cards.edit(task)}>{msg("编辑任务")}</button>
          {!owner && task.status!=="queued" && startableStatuses.includes(task.status) && <button disabled={busy} onClick={()=>move(task,"queued")}>{msg("加入队列")}</button>}
          {task.status==="queued"&&!owner && <button disabled={busy} onClick={()=>move(task,"todo")}>{msg("移回待办")}</button>}
          {task.status === "review" && <button disabled={busy} onClick={() => cards.review(task)}>{msg("验收任务")}</button>}
          {canRefineStatus(task.status) && <button disabled={busy} onClick={() => cards.refine(task)}>{msg("继续优化")}</button>}
          <button disabled={busy||owner==="running"||owner==="recover"} onClick={()=>cards.lifecycle(task,"archived")}>{msg("归档任务")}</button>
          <button className="danger" disabled={busy||owner==="running"||owner==="recover"} onClick={()=>cards.lifecycle(task,"trash")}>{msg("删除任务")}</button>
        </>}
        {editable&&!active&&<button disabled={busy} onClick={()=>cards.lifecycle(task,"active")}>{msg("恢复任务")}</button>}
        {session && <button onClick={()=>cards.session(session.id)}>{msg("跳转")} {hostName} {msg("会话")}</button>}
      </Menu>
    </div>;
  }
  return <div className="page-content list-page tasks-page">
    <header className="list-toolbar" aria-label={msg("任务工具栏")}>
      <div className="filters">
        <Search label={msg("搜索任务")} value={query} change={setQuery} />
        <label className="sr-only" htmlFor="task-scope">{msg("任务范围")}</label>
        <select id="task-scope" value={scope} onChange={event => setScope(event.target.value as Lifecycle)}>
          {lifecycles.map(value => <option key={value} value={value}>{msg(lifecycleLabels[value])}</option>)}
        </select>
        {mode === "table" && <>
          <label className="sr-only" htmlFor="task-status-filter">{msg("按任务状态筛选")}</label>
          <select value={filter} id="task-status-filter" onChange={event => setFilter(event.target.value as TaskFilter)}>
            <option value="all">{msg("全部状态")}</option>
            {taskStatuses.map(status => <option value={status} key={status}>{msg(taskLabels[status])}</option>)}
          </select>
        </>}
        {mode === "board" && <BoardScrollButtons board={board} />}
      </div>
      <div className="list-actions">
        <span className="list-count" role="status">{result.length} {term ? msg("项匹配") : msg("项任务")}</span>
        <div className="segments" aria-label={msg("任务视图")}>
          <button type="button" aria-pressed={mode === "board"} onClick={() => setMode("board")}><Icon name="board" />{msg("看板")}</button>
          <button type="button" aria-pressed={mode === "table"} onClick={() => setMode("table")}><Icon name="table" />{msg("表格")}</button>
        </div>
        {canEdit && <button className="primary" onClick={() => add()} disabled={busy}><Icon name="plus" />{msg("新建任务")}</button>}
      </div>
    </header>
    {mode === "board" ? <Kanban controls={controls} board={board} tasks={result} owners={owners} editable={boardEditable}
      add={canEdit ? add : undefined} busy={busy} open={open} move={move} />
      : <TaskTable controls={controls} owners={owners} editable={canEdit} busy={busy} move={move} tasks={result} open={open} filtered={Boolean(term) || filter !== "all"} />}
  </div>;
}

function BoardScrollButtons({ board }: { board: RefObject<HTMLDivElement | null> }) {
  const [canScroll, setCanScroll] = useState({ back: false, forward: false });

  useEffect(() => {
    const el = board.current!;
    const update = () => {
      const back = el.scrollLeft > 2;
      const forward = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
      setCanScroll(prev => prev.back === back && prev.forward === forward ? prev : { back, forward });
    };
    const resize = new ResizeObserver(update);
    resize.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      resize.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [board]);

  function scroll(direction: number) {
    const el = board.current!;
    const column = el.firstElementChild?.getBoundingClientRect().width ?? el.clientWidth;
    el.scrollBy({ left: direction * (column + 11), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  if (!canScroll.back && !canScroll.forward) return null;
  return <div className="board-scroll-buttons">
    <button className="icon-button ghost" onClick={() => scroll(-1)} aria-label={msg("查看左侧状态列")} title={msg("查看左侧状态列")}
      disabled={!canScroll.back}><Icon name="left" size={15} /></button>
    <button className="icon-button ghost" onClick={() => scroll(1)} aria-label={msg("查看右侧状态列")} title={msg("查看右侧状态列")}
      disabled={!canScroll.forward}><Icon name="right" size={15} /></button>
  </div>;
}

function Kanban({ controls, board, tasks, owners, editable, add, busy, open, move }: {
  controls:(task:Task)=>React.ReactNode; board: RefObject<HTMLDivElement | null>; tasks: Task[]; owners: Map<string, Run["status"]>; editable: boolean;
  add?: (status: TaskStatus) => void; busy: boolean; open: (id: string) => void; move: (task: Task, status: TaskStatus) => void;
}) {
  const taskRef = useRef<Task | undefined>(undefined);
  const frame = useRef(0);
  const speed = useRef(0);
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<TaskStatus>();
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function canMove(task: Task, target?: TaskStatus) {
    if (!editable || task.status === target) return false;
    const owner = owners.get(task.id);
    return !owner || (owner === "review" && task.status === "review" && (!target || target === "done"));
  }

  function endDrag() {
    taskRef.current = undefined;
    speed.current = 0;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setDragging(undefined);
    setOver(undefined);
  }

  function pan() {
    const el = board.current;
    frame.current = 0;
    if (!el || !speed.current || !taskRef.current) return;
    const last = el.scrollLeft;
    el.scrollLeft += speed.current;
    if (last !== el.scrollLeft) frame.current = requestAnimationFrame(pan);
  }

  function followEdge(event: DragEvent<HTMLDivElement>) {
    if (!taskRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const gutter = Math.min(54, bounds.width / 6);
    speed.current = event.clientX > bounds.right - gutter ? 12 : event.clientX < bounds.left + gutter ? -12 : 0;
    if (speed.current && !frame.current) frame.current = requestAnimationFrame(pan);
  }

  return <section className="kanban" aria-label={msg("任务看板")}>
    <div className="board-scroll" ref={board} onDragOver={followEdge}
      onDragLeave={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
          speed.current = 0;
          setOver(undefined);
        }
      }}>
      {taskStatuses.map(status => {
        const items = tasks.filter(task => task.status === status);
        return <section className="board-column" key={status} data-status={status} data-over={over === status}
          aria-label={msg("{0}任务", msg(taskLabels[status]))}
          onDragOver={event => {
            const task = taskRef.current;
            if (!task || !canMove(task, status)) {
              if (over) setOver(undefined);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (over !== status) setOver(status);
          }}
          onDrop={event => {
            const task = taskRef.current;
            if (!task || !canMove(task, status)) return;
            event.preventDefault();
            endDrag();
            move(task, status);
          }}>
          <header className="column-header"><Status status={status} /><span className="column-count">{items.length}</span></header>
          {add && <button className="column-add ghost" aria-label={msg("在{0}列新建任务", msg(taskLabels[status]))}
            disabled={busy} onClick={() => add(status)}><Icon name="plus" size={15} />{msg("新建任务")}</button>}
          <div className="column-cards">
            {items.map(task => <article className="task-card" key={task.id} data-moving={dragging === task.id}
              draggable={canMove(task)}
              onDragStart={event => {
                if (!canMove(task)) { event.preventDefault(); return; }
                taskRef.current = task;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-moki-task", task.id);
                setDragging(task.id);
              }}
              onDragEnd={endDrag}>
              <button className="task-card-main" onClick={() => open(task.id)}><TaskSummary task={task} /></button>
              <div className="task-card-meta">
                <div className="card-facts">
                  <time dateTime={task.updatedAt}>{msg("更新于")} {shortDate(task.updatedAt)}</time>
                  {task.inputVersionIds.length > 0 && <span className="card-input-count" title={msg("{0} 项关联输入", task.inputVersionIds.length)}>
                    <Icon name="link" size={13} />{task.inputVersionIds.length}
                  </span>}
                </div>
                <div className="card-tools">
                  {controls(task)}
                  {canMove(task) && <span className="card-grip" title={task.status === "review" ? msg("拖到完成列即可验收") : undefined}
                    aria-hidden="true"><Icon name="grip" size={15} /></span>}
                </div>
              </div>
            </article>)}
          </div>
        </section>;
      })}
    </div>
  </section>;
}

function TaskSummary({ task }: { task: Task }) {
  const lines = task.instructions.split(/\r?\n/);
  const summary = lines[0] === task.title ? lines.slice(1).join(" ").trim() : task.instructions;
  return <><strong title={task.title}>{task.title}</strong>{summary && <span>{summary}</span>}</>;
}

function TaskStatusPicker({task, owner, editable, busy, label, move}: {
  task: Task; owner?: Run["status"]; editable: boolean; busy: boolean; label: string; move: (status: TaskStatus) => void;
}) {
  const choices = owner === "review" && task.status === "review" ? (["review", "done"] as const) : owner ? [] : taskStatuses;
  if (!editable || !choices.length) return <Status status={task.status} />;
  return <label className="status-picker"><Status status={task.status} /><Icon name="down" size={12} />
    <select aria-label={label} value={task.status} disabled={busy} onChange={e=>move(e.target.value as TaskStatus)}>
      {choices.map(status=><option key={status} value={status}>{msg(taskLabels[status])}{status === "running" ? msg("（手动标记）") : ""}</option>)}
    </select>
  </label>;
}

function TaskTable({ controls,tasks, open, filtered, owners, editable, busy, move }: {
  owners: Map<string,Run["status"]>; editable: boolean; busy: boolean; move: (task:Task, status:TaskStatus)=>void;
  controls:(task:Task)=>React.ReactNode; tasks: Task[]; open: (id: string) => void; filtered: boolean }) {
  if (!tasks.length) return <Empty icon="tasks" title={filtered ? msg("没有匹配的任务") : msg("此范围暂无任务")} />;
  return <div className="table-frame"><table className="task-table" aria-label={msg("任务表格")}>
    <thead><tr><th scope="col">{msg("任务")}</th><th scope="col">{msg("状态")}</th><th scope="col" className="table-inputs">{msg("输入资产")}</th>
      <th scope="col" className="table-date">{msg("更新时间")}</th><th scope="col">{msg("操作")}</th></tr></thead>
    <tbody>{tasks.map(task => <tr key={task.id}>
      <td><button className="table-task" onClick={() => open(task.id)}>
        <TaskSummary task={task} />
      </button></td>
      <td><TaskStatusPicker task={task} owner={owners.get(task.id)} editable={editable} busy={busy}
        label={msg("切换任务状态 {0}", task.title)} move={status=>move(task,status)} /></td>
      <td className="table-inputs muted">{task.inputVersionIds.length} {msg("项")}</td>
      <td className="table-date muted"><time dateTime={task.updatedAt}>{shortDate(task.updatedAt)}</time></td><td>{controls(task)}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function TaskDrawer({ conversationFiles,recognized,approve, sources,workUpdates,jumpThread,task, assets, runs, focusRun, editable, busy, canStart, nativeFiles, error, message,
  close, edit, start, move, moveQueue, changeLifecycle, preview, session, review, refine, stop, reconcile }: {
  conversationFiles:ConversationFile[]; recognized:boolean; approve:(runId:string,id:string,decision:string)=>void; sources?:React.ReactNode; workUpdates:ConversationUpdate[]; jumpThread:(id:string)=>void;
  task: Task; assets: Asset[]; runs: Run[]; focusRun?: string; editable: boolean; busy: boolean;
  canStart: boolean; nativeFiles: boolean; error: string; message: string;
  close: () => void; edit: () => void; start: () => void; move: (status: TaskStatus) => void;
  moveQueue: (direction: "up" | "down") => void; changeLifecycle: (lifecycle: Lifecycle) => void;
  preview: (id: string) => void; session: (id: string) => void; review: (run?: Run) => void; refine: (run?: Run) => void;
  stop: (id: string) => void; reconcile: (id: string) => void;
}) {
  const active = editable && task.lifecycle === "active";
  const owner = runs.find(run => runControlsStatus(run.status));
  const firstRun = runs.find(run => run.id === focusRun) ?? runs[0];
  const pendingApprovals = firstRun?.approvals.filter(item => item.status === "pending").length ?? 0;
  const prior = runs.filter(run => run.id !== firstRun?.id);
  function conversationRecords(runId:string|null) {
    const items=workUpdates.filter(u=>u.runId===runId);
    return items.length ? <details className="task-work-updates"><summary>{msg("会话交接与执行记录 ·")} {items.length}</summary>
      {items.map(u=><WorkUpdate item={u} key={u.id} jump={jumpThread}/>)}</details> : null;
  }
  const inputs = assets.flatMap(asset => asset.versions
    .filter(version => task.inputVersionIds.includes(version.id)).map(version => ({ asset, version })));
  const hasCriteria = Boolean(task.expectedFiles.length || task.textChecks.length || task.reviewCriteria);
  let action = null;
  if (owner?.status === "running") {
    action = <button disabled={busy || Boolean(owner.stopRequested)} onClick={() => stop(owner.id)}>
      {owner.stopRequested ? msg("等待中断回执") : msg("停止运行")}
    </button>;
  } else if (owner?.status === "recover") {
    action = <button className="primary" disabled={busy} onClick={() => reconcile(owner.id)}>{msg("重新核对运行")}</button>;
  } else if (active && canRefineStatus(task.status)) {
    action = <>
      {task.status === "review" && <button className="primary" disabled={busy} onClick={() => review(owner)}>{owner ? msg("验收本次执行") : msg("验收任务")}</button>}
      <button className={task.status === "done" ? "primary" : undefined} disabled={busy}
        onClick={() => refine(owner)}><Icon name="compose" size={15} />{msg("继续优化")}</button>
    </>;
  } else if (active && !owner && startableStatuses.includes(task.status)) {
    action = <button className="primary" disabled={busy || !canStart} onClick={start}><Icon name="play" size={15} />{msg("启动任务")}</button>;
  } else if (editable && !active) {
    action = <button disabled={busy} onClick={() => changeLifecycle("active")}>{msg("恢复任务")}</button>;
  }
  return <Dialog title={msg("任务详情")} close={close} drawer>
    <Notice error={error} message={message} />
    <div className="task-hero">
      <ModuleIcon name="task" />
      <h3>{task.title}</h3>
      <div className="task-hero-status">
        <TaskStatusPicker task={task} owner={owner?.status} editable={active} busy={busy} label={msg("移动到状态")} move={move} />
        {task.lifecycle !== "active" && <span className="tag">{msg(lifecycleLabels[task.lifecycle])}</span>}
        {!owner && (recognized || (active && task.status === "running")) && <small className="muted">{recognized ? msg("会话识别") : msg("手动标记")}</small>}
      </div>
    </div>
    {(action || firstRun?.threadId || active) && <div className="drawer-actions">
      {action}
      {firstRun?.threadId && <button onClick={() => session(firstRun.id)}><Icon name="external" size={15} />{msg("跳转")} {hostName} {msg("会话")}</button>}
      {active && <>
        <button onClick={edit} disabled={busy}>{msg("编辑任务")}</button>
        <Menu label={msg("任务操作")}>
          {task.status === "queued" && <><button disabled={busy} onClick={() => moveQueue("up")}>{msg("队列上移")}</button>
            <button disabled={busy} onClick={() => moveQueue("down")}>{msg("队列下移")}</button></>}
          <button disabled={busy || Boolean(owner && owner.status !== "review")} onClick={() => changeLifecycle("archived")}>{msg("归档任务")}</button>
          <button className="danger" disabled={busy || Boolean(owner && owner.status !== "review")}
            onClick={() => changeLifecycle("trash")}>{msg("删除任务")}</button>
        </Menu>
      </>}
    </div>}
    <TaskDescription value={task.instructions} />
    {(hasCriteria||runs.length>0||task.status==="review"||task.status==="done"||task.reviews.length>0||conversationFiles.some(f=>f.role==="output"))&&<Acceptance conversationDone={recognized && task.status==="done"} task={task} run={firstRun} files={conversationFiles} preview={nativeFiles?preview:undefined}/>}
    {sources}
    <Usage runs={runs} title={msg("任务用量")} />
    {conversationRecords(null)}
    {firstRun && firstRun.approvals.length > 0 && <section key={firstRun.id} className="task-folds task-approvals">
      <Disclosure title={msg("操作审批")} icon="task" open={pendingApprovals > 0}
        meta={pendingApprovals ? msg("{0} 条待处理 / 共 {1} 条", pendingApprovals, firstRun.approvals.length) : msg("{0} 条记录", firstRun.approvals.length)}>
        {firstRun.approvals.map(item => {
          const pending = item.status === "pending";
          const status = pending ? msg("待处理") : item.status === "accept" ? msg("已允许") : item.status === "decline" ? msg("已拒绝") : msg("已过期");
          return <Disclosure key={item.id} title={approvalTitle(item.kind)} meta={status + " · " + timestamp(item.createdAt)} open={pending}>
            <pre tabIndex={0}>{item.detail}</pre>
            {pending && (item.kind === "dsh/approval" ? <button onClick={() => session(firstRun.id)}>{msg("前往 DSH 会话审批")}</button> :
              <div className="row"><button disabled={busy} onClick={() => approve(firstRun.id, item.id, "accept")}>{msg("允许本次操作")}</button>
                <button disabled={busy} onClick={() => approve(firstRun.id, item.id, "decline")}>{msg("拒绝操作")}</button></div>)}
          </Disclosure>;
        })}
      </Disclosure>
    </section>}

    {firstRun && <section className="task-execution">
      <div className="execution-summary">
        <span className="file-icon"><Icon name="clock" /></span>
        <div><h4>{firstRun.id === runs[0]?.id ? msg("最近执行") : msg("所选执行")}</h4><p className="muted">{msg(firstRun.phase)}</p></div>
        <Status status={firstRun.status} label={msg(runLabels[firstRun.status])} />
      </div>
      <Disclosure key={firstRun.id} title={msg("执行详情与产物")} meta={firstRun.files.length ? msg("{0} 项产物", firstRun.files.length) : undefined}>
        <RunCard run={firstRun} records={conversationRecords(firstRun.id)} preview={preview} nativeFiles={nativeFiles} />
      </Disclosure>
    </section>}

    {(conversationFiles.length > 0 || inputs.length > 0 || hasCriteria || prior.length > 0 || task.reviews.length > 0) && <div className="task-folds">
      {task.reviews.length > 0 && <Disclosure title={msg("验收与补充记录")} meta={msg("{0} 条", task.reviews.length)} icon="task">
        <ol className="review-history">{task.reviews.slice().reverse().map(entry => <li key={entry.seq}>
          <div className="row between"><strong>{{ accept: msg("验收通过"), return: msg("退回待办"), refine: msg("补充需求") }[entry.decision]}</strong>
            <time className="muted" dateTime={entry.createdAt}>{timestamp(entry.createdAt)}</time></div>
          {entry.note && <p className="prose">{entry.note}</p>}
        </li>)}</ol>
      </Disclosure>}
      {conversationFiles.length > 0 && <Disclosure title={msg("会话资料与产物")} meta={msg("{0} 条", conversationFiles.length)} icon="file">
        <ConversationFiles files={conversationFiles} preview={nativeFiles?preview:undefined} jump={jumpThread}/>
      </Disclosure>}
      {inputs.length > 0 && <Disclosure title={msg("关联输入")} meta={msg("{0} 项", inputs.length)} icon="link">
        <div className="input-list">
          {inputs.map(({ asset, version }) => nativeFiles ? <button className="tag" onClick={() => preview(version.id)} key={version.id}>
            <FileIcon name={version.fileName} size={13} />{asset.name} v{version.revision}
          </button> : <span className="tag" key={version.id}>{asset.name} v{version.revision}</span>)}
        </div>
      </Disclosure>}
      {hasCriteria && <Disclosure title={msg("交付与验收要求")} icon="task">
        <div className="task-criteria">
          {task.expectedFiles.length > 0 && <p><strong>{msg("必交文件")}</strong> {task.expectedFiles.join("、")}</p>}
          {task.textChecks.length > 0 && <ul>{task.textChecks.map((rule, index) =>
            <li key={index}>{rule.path} {msg("· 包含")} {rule.contains}</li>)}</ul>}
          {task.reviewCriteria && <p className="prose">{task.reviewCriteria}</p>}
        </div>
      </Disclosure>}
      {prior.length > 0 && <Disclosure title={msg("历史执行")} meta={msg("{0} 次", prior.length)} icon="clock">
        <div className="past-executions">
          {prior.map(run => <Disclosure key={run.id} title={msg(run.phase)} meta={msg(runLabels[run.status])}>
            <RunCard run={run} records={conversationRecords(run.id)} preview={preview} session={session} nativeFiles={nativeFiles} />
          </Disclosure>)}
        </div>
      </Disclosure>}
    </div>}
    <p className="drawer-updated muted"><time dateTime={task.updatedAt}>{msg("更新于")} {timestamp(task.updatedAt)}</time></p>
  </Dialog>;
}

function TaskDescription({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (expanded) return;
    const el = text.current!;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    measure();
    return () => resize.disconnect();
  }, [expanded, value]);
  return <section className="task-description"><h4>{msg("任务说明")}</h4>
    <p className="prose" ref={text} data-expanded={expanded}>{value}</p>
    {clipped && <button className="text-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
      {expanded ? msg("收起说明") : msg("展开说明")}<Icon name={expanded ? "right" : "down"} size={13} />
    </button>}
  </section>;
}

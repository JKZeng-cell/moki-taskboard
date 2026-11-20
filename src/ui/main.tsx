import { msg, subscribeLocale, uiLocale } from "./i18n.ts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Asset, BoardState, Lifecycle, Params, Project, Run, Task, TaskStatus } from "../types.ts";
import { version } from "../version.ts";
import { defaultActivityWeeks, type ActivityWeeks } from "../calendar.ts";
import { action, connectHost, openFile, openSession } from "./bridge.ts";
import { isDsh } from "../host-identity.ts";
import { DshFilePreview } from "./dsh-file-preview.tsx";
import { StartForm } from "./execution-session.tsx";
import { ApprovalInbox } from "./approval-inbox.tsx";
import { PolicyForm } from "./policy-form.tsx";
import { CaptureEvidence } from "./capture-evidence.tsx";
import { SessionsPage } from "./sessions-page.tsx";
import { SessionBindingForm } from "./session-binding.tsx";
import type { Link } from "../capture.ts";
import { openLinkedThread } from "./bridge.ts";
import {AssetEditor} from "./asset-editor.tsx";
import { AssetsPage } from "./assets-page.tsx";
import { Dialog, Empty, Icon, Notice, taskLabels } from "./common.tsx";
import { AssetForm, ImportForm, ProjectForm, RefineForm, ReviewForm, TaskForm } from "./forms.tsx";
import { ReleaseForm } from "./project-activity.tsx";
import type { ProjectRelease } from "../types.ts";
import { Overview } from "./overview.tsx";
import { Portfolio, Shell } from "./projects.tsx";
import type { ProjectOperations, Route } from "./projects.tsx";
import { QuickTask } from "./quick-task.tsx";
import { TaskDrawer, TasksPage } from "./tasks.tsx";
import type { TaskFilter, TaskMode } from "./tasks.tsx";

const initial: BoardState = { groups:[], layoutVersion:0, policy:null, edits:[], sessions:{links:[],sources:[]}, composerMinimized: false, sidebarCollapsed: false, assetView: "list", projects: [], project: null, tasks: [], assets: [], runs: [] };
const home: Route = { page: "projects" };
type Editor =
  | { kind:"start"; project:Project; task?:Task }
  | { kind: "project"; value?: Project }
  | { kind: "task"; value?: Task; status?: TaskStatus }
  | { kind: "asset"; value: Asset }
  | { kind:"file";value:Asset;draftId:string }
  | { kind: "binding"; link?: Link }
  | { kind: "policy" }
  | { kind: "release"; value?: ProjectRelease }
  | { kind: "import" }
  | { kind: "review" | "refine"; task: Task; run?: Run };

function App() {
  useSyncExternalStore(subscribeLocale, uiLocale);
  const [board, setBoard] = useState(initial);
  const [route, setRoute] = useState<Route>(home);
  const current = useRef<Route>(home);
  const [ready, setReady] = useState(false);
  const [nativeFiles, setNativeFiles] = useState(false);
  const [projectScope, setProjectScope] = useState<Lifecycle>("active");
  const [taskMode, setTaskMode] = useState<TaskMode>("board");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [detail, setDetail] = useState<{ id: string; runId?: string }>();
  const [editor, setEditor] = useState<Editor>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const locked = useRef(false);
  const [pendingSidebar, setPendingSidebar] = useState<boolean>();
  const sidebarWrites = useRef(Promise.resolve());
  const sidebarSequence = useRef(0);

  const refresh = useCallback(async (target = current.current) => {
    const index = ++latest.current;
    const selection = target.page === "projects" ? { projectsOnly: true } : {
      projectId: target.projectId,
      activityWeeks: target.page === "overview" ? target.activityWeeks : undefined
    };
    const update = await action<BoardState>("state", selection);
    if (latest.current === index) setBoard(update);
  }, []);

  const initialize = useCallback(async () => {
    setError("");
    try {
      const host = await connectHost();
      const health = await action<{ version: string; protocol: number }>("health");
      if (health.version !== version) throw new Error(msg("任务台后台为 {0}，请在后台更新到 {1} 后重连。", health.version, version));
      setNativeFiles(host.nativeFiles);
      await refresh();
      setReady(true);
    } catch (error) { setError((error as Error).message); }
  }, [refresh]);

  useEffect(() => { void initialize(); }, [initialize]);

  const live = board.runs.some(run => run.status === "running" || run.status === "recover");
  const classifying = (board.semantics?.pending ?? 0) > 0;
  const liveProjects = board.projects.some(item => item.liveRunStatus === "running");
  useEffect(() => {
    if (!ready) return;
    const update = () => {
      if (!locked.current && !document.hidden) void refresh().catch(error => setError((error as Error).message));
    };
    const timer = window.setInterval(update, live || liveProjects || classifying ? 1500 : 12000);
    window.addEventListener("focus", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); };
  }, [ready, live, liveProjects, classifying, refresh]);

  function clearNotices() {
    setMessage("");
    setError("");
  }

  function changeSidebar(collapsed: boolean) {
    setPendingSidebar(collapsed);
    const sequence = ++sidebarSequence.current;
    sidebarWrites.current = sidebarWrites.current.then(async () => {
      try {
        await action("ui.sidebar", { collapsed });
        if (sequence === sidebarSequence.current) await refresh();
      } catch (error) { setError((error as Error).message); }
      if (sequence === sidebarSequence.current) setPendingSidebar(undefined);
    });
  }

  function navigate(next: Route) {
    const previous = current.current;
    if (previous.page === next.page && (previous.page === "projects" || (next.page !== "projects" && previous.projectId === next.projectId))) return;
    current.current = next;
    setRoute(next);
    setDetail(undefined);
    setTaskFilter("all");
    clearNotices();
    if (next.page === "overview" || next.page === "projects" || previous.page === "projects" || previous.projectId !== next.projectId) {
      void refresh(next).catch(error => { if (current.current === next) setError((error as Error).message); });
    }
  }

  function changeActivityRange(weeks: ActivityWeeks) {
    if (current.current.page !== "overview") return;
    const next = { ...current.current, activityWeeks: weeks };
    current.current = next;
    setRoute(next);
    void refresh(next).catch(error => { if (current.current === next) setError((error as Error).message); });
  }

  async function mutate<T>(name: string, params: Params | (() => Promise<Params>), notice: string, after?: (result: T) => void) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    clearNotices();
    try {
      const result = await action<T>(name, typeof params === "function" ? await params() : params);
      after?.(result);
      await refresh();
      setMessage(notice);
    } catch (error) {
      setError((error as Error).message);
      await refresh().catch(() => {});
    } finally { locked.current = false; setBusy(false); }
  }

  const project = route.page !== "projects" && board.project?.id === route.projectId ? board.project : null;
  const editable = project?.lifecycle === "active";
  const canStart = editable && !live && !board.policy?.paused && board.window?.open!==false && !board.projects.some(p=>p.liveRunStatus&&p.root.toLowerCase()===project?.root.toLowerCase());
  const task = project ? board.tasks.find(item => item.id === detail?.id) : undefined;

  const lifecycle = (kind: "project" | "task" | "asset", item: { id: string; version: number }, next: Lifecycle) =>
    void mutate<{ lifecycle: Lifecycle }>(`${kind}.lifecycle`, { id: item.id, version: item.version, lifecycle: next },
      next === "trash" ? msg("已移入回收站") : next === "archived" ? msg("已归档") : msg("已恢复"), result => {
        if (kind === "project") setProjectScope(result.lifecycle);
      });

  const move = (item: Task, status: TaskStatus) =>
    void mutate("task.status", { id: item.id, version: item.version, status },
      item.status === "review" && status === "done" ? msg("验收通过，任务已完成") : msg("已移至{0}", msg(taskLabels[status])));

  function openTask(id: string, runId?: string) {
    clearNotices();
    setDetail({ id, runId });
  }

  function openEditor(value: Editor) {
    clearNotices();
    setEditor(value);
  }

  function startTask(item:Task) {
    if(project)openEditor({kind:"start",project,task:item});
  }

  function startProject(item: Project) {
    openEditor({kind:"start",project:item});
  }

  function editFile(asset:Asset,resume=false){
    const draft=resume?board.edits.findLast(e=>e.assetId===asset.id):null;
    if(draft){openEditor({kind:"file",value:asset,draftId:draft.id});return;}
    void mutate<{id:string}>("asset.editBegin",{projectId:project!.id,assetId:asset.id,versionId:asset.versions[0].id},"",d=>openEditor({kind:"file",value:asset,draftId:d.id}));
  }

  async function preview(versionId: string) {
    try {
      const file = await action<{ path: string }>("asset.preview", { projectId: project?.id, versionId });
      await openFile(file);
    } catch (error) { setError((error as Error).message); }
  }

  function session(runId: string) {
    void openSession(runId).catch(error => setError((error as Error).message));
  }

  if (!ready) return <main className="startup">
    <span className="brand-icon"><Icon name="brand" size={20} /></span>
    <h1>{msg("MOKI任务台")}</h1>
    {error ? <><Notice error={error} /><button onClick={() => void initialize()}>{msg("重新连接")}</button></>
      : <p className="muted" role="status">{msg("正在连接本机任务服务")}</p>}
  </main>;

  function closeEditor() {
    if (locked.current) return;
    setEditor(undefined);
    clearNotices();
  }

  const reload = () => { void refresh().catch(error => setError((error as Error).message)); };
  const projectOps:ProjectOperations={
      groups:board.groups, arrange:params=>void mutate("ui.arrange",{...params,layoutVersion:board.layoutVersion}, ""),
      create: () => openEditor({ kind: "project" }),
      edit: value => openEditor({ kind: "project", value }),
      start: startProject,
      changeLifecycle: (value, next) => lifecycle("project", value, next)
    };
  return <Shell route={route} projects={board.projects} scope={projectScope} setScope={setProjectScope} navigate={navigate} busy={busy}
    collapsed={pendingSidebar ?? board.sidebarCollapsed} setCollapsed={changeSidebar}
    composer={<QuickTask projects={board.projects} current={route.page === "projects" ? undefined : route.projectId}
      initiallyMinimized={board.composerMinimized} busy={busy} refresh={reload} createProject={() => openEditor({ kind: "project" })}
      open={item => {
        navigate({ page: "tasks", projectId: item.projectId });
        openTask(item.taskId, item.runId ?? undefined);
      }} />}
    operations={projectOps}
    refresh={() => { clearNotices(); reload(); }}>
    {!editor && !task && <Notice error={error} message={message} />}
    {route.page === "projects" ? <Portfolio busy={busy} operations={projectOps} projects={board.projects} scope={projectScope}
      open={projectId => navigate({ page: "overview", projectId })} />
      : !project ? <Empty title={error ? msg("无法打开项目") : msg("正在加载项目")} />
      : route.page === "overview" ? <Overview activityWeeks={route.activityWeeks ?? defaultActivityWeeks} changeActivityRange={changeActivityRange}
        editRelease={value=>openEditor({kind:"release",value})} jumpThread={id=>void openLinkedThread(project.id,id).catch(e=>setError(e.message))} configure={()=>openEditor({kind:"policy"})} key={project.id} board={board} project={project} busy={busy} canStart={canStart}
        nativeFiles={nativeFiles} openTask={openTask} preview={preview} session={session}
        goTasks={status => {
          navigate({ page: "tasks", projectId: project.id });
          if (status) { setTaskMode("table"); setTaskFilter(status); }
        }}
        goAssets={() => navigate({ page: "assets", projectId: project.id })}
        changeLifecycle={value => lifecycle("project", project, value)}
        edit={() => openEditor({ kind: "project", value: project })} start={() => startProject(project)} />
      : route.page === "tasks" ? <TasksPage key={project.id} tasks={board.tasks} runs={board.runs} mode={taskMode} filter={taskFilter}
        setMode={mode => { setTaskMode(mode); if (mode === "board") setTaskFilter("all"); }}
        setFilter={setTaskFilter} editable={editable} busy={busy}
        cards={{start:startTask,canStart:!!canStart,edit:value=>openEditor({kind:"task",value}),session,
          review:item=>openEditor({kind:"review",task:item,run:board.runs.find(r=>r.taskId===item.id&&r.status==="review")}),
          refine:item=>openEditor({kind:"refine",task:item,run:board.runs.find(r=>r.taskId===item.id&&r.status==="review")}),lifecycle:(item,value)=>lifecycle("task",item,value)}}
        add={status => openEditor({ kind: "task", status })} open={openTask} move={move} />
      : route.page==="sessions" ? <SessionsPage key={project.id} board={board} busy={busy} open={openTask} session={session}
        bind={link => openEditor({ kind: "binding", link })} preview={nativeFiles ? preview : undefined}
        jump={id => void openLinkedThread(project.id, id).catch(e => setError(e.message))}
        change={p=>void mutate("thread.bind",{...p,projectId:project.id},msg("会话归属已更新"))}
        scan={()=>void mutate("thread.scan",{projectId:project.id},board.policy?.semanticScope && board.policy.semanticScope !== "off" ? msg("已扫描会话，语义识别将在后台完成") : msg("会话扫描完成"))} policy={()=>openEditor({kind:"policy"})}/>
      : <AssetsPage board={board} jump={id=>void openLinkedThread(project.id,id).catch(e=>setError(e.message))} view={board.assetView} setView={view => void mutate("ui.assetView", { view }, "")} drafts={new Set(board.edits.map(e=>e.assetId))} content={asset=>editFile(asset)} resume={asset=>editFile(asset,true)}
        refreshSource={asset=>void mutate("asset.refreshSource",{projectId:project.id,assetId:asset.id,expectedLatest:asset.versions[0].id},msg("源文件版本已核对"))} key={project.id} handoff={project.handoffVersionId} editable={editable}
        nativeFiles={nativeFiles} busy={busy} preview={preview}
        add={() => openEditor({ kind: "import" })} edit={value => openEditor({ kind: "asset", value })}
        changeLifecycle={(asset, value) => lifecycle("asset", asset, value)} />}

    {task && <TaskDrawer conversationFiles={board.sessions.files?.filter(f=>f.taskId===task.id) ?? []} recognized={board.sessions.sources.some(s=>s.taskId===task.id && s.status==="active" && s.taskVersion===task.version && s.recognizedState?.status===task.status)} workUpdates={board.dashboard?.updates.filter(u=>u.taskId===task.id) ?? []} jumpThread={id=>void openLinkedThread(task.projectId,id).catch(e=>setError(e.message))} sources={board.sessions.sources.some(s=>s.taskId===task.id&&s.status==="active")&&<div className="source-item"><h4>{msg("来源会话")}</h4>
      {board.sessions.sources.filter(s=>s.taskId===task.id&&s.status==="active").map(s=><div key={s.threadId+s.turnId+s.anchor}>
        <button className="text-button" title={s.turnId} onClick={()=>void openLinkedThread(task.projectId,s.threadId).catch(e=>setError(e.message))}>{s.title} <Icon name="external" size={13}/></button>
        <CaptureEvidence source={s} jump={id=>void openLinkedThread(task.projectId,id).catch(e=>setError(e.message))}/></div>)}</div>} approve={(runId,id,decision)=>void mutate("approval.decide",{runId,id,decision},msg("已提交审批决定"))} key={task.id} task={task} assets={board.assets} runs={board.runs.filter(run => run.taskId === task.id)}
      focusRun={detail?.runId} editable={editable} busy={busy} canStart={canStart} nativeFiles={nativeFiles}
      error={editor ? "" : error} message={editor ? "" : message}
      close={() => { if (!locked.current) { setDetail(undefined); clearNotices(); } }}
      edit={() => openEditor({ kind: "task", value: task })} move={status => move(task, status)}
      moveQueue={direction => void mutate("task.move", { id: task.id, version: task.version, direction }, msg("已调整队列"))}
      changeLifecycle={value => lifecycle("task", task, value)}
      start={()=>startTask(task)}
      preview={preview} session={session} review={run => openEditor({ kind: "review", task, run })}
      refine={run => openEditor({ kind: "refine", task, run })}
      stop={runId => void mutate("run.stop", { runId }, msg("已请求中断"))}
      reconcile={runId => void mutate("run.reconcile", { runId }, msg("已核对运行记录"))} />}

    {editor && <Dialog title={editor.kind==="start"?msg("启动任务"):editor.kind === "project" ? (editor.value ? msg("编辑项目") : msg("新建项目")) :
      editor.kind === "release" ? (editor.value ? msg("编辑上线版本") : msg("登记上线版本")) :
      editor.kind === "task" ? (editor.value ? msg("编辑任务") : msg("新建任务")) :
      editor.kind === "binding" ? (editor.link?.kind === "ignored" ? msg("恢复绑定") : editor.link ? msg("调整归属") : msg("绑定会话")) :
      editor.kind === "file" ? msg("编辑文件内容") : editor.kind === "policy" ? msg("执行与归集设置") : editor.kind === "import" ? msg("导入资产") : editor.kind === "asset" ? msg("编辑资产") : editor.kind === "refine" ? msg("继续优化") : msg("执行验收")} close={closeEditor}>
      <Notice error={error} />
      {editor.kind==="start" && <StartForm project={editor.project} task={editor.task} busy={busy} cancel={closeEditor}
        submit={(sessionChoice,key)=>{
          const target=editor.task??editor.project;
          void mutate<{id:string;taskId:string}>(editor.task?"task.start":"project.start",{id:target.id,version:target.version,requestKey:key,sessionChoice},msg("已启动任务"),result=>{
            setEditor(undefined);
            if(!editor.task)navigate({page:"tasks",projectId:editor.project.id});
            openTask(result.taskId,result.id);
          });
        }}/>}
      {editor.kind === "release" && project && <ReleaseForm release={editor.value} busy={busy}
        save={values=>void mutate("project.release",{...values,projectId:project.id},msg("上线版本已保存"),()=>setEditor(undefined))}/>}
      {editor.kind === "project" && <ProjectForm key={editor.value?.id ?? "new"} project={editor.value} categories={board.projects.map(item => item.category)} busy={busy} save={values =>
        void mutate<{ id: string }>("project.save", values, msg("项目已保存"), result => {
          if (!editor.value) {
            setProjectScope("active");
            navigate({ page: "overview", projectId: result.id });
          }
          setEditor(undefined);
        })} />}
      {editor.kind==="file"&&project&&<AssetEditor projectId={project.id} asset={editor.value} draftId={editor.draftId} native={nativeFiles}
        done={()=>{setEditor(undefined);setMessage(msg("资产版本已登记"));reload();}}/>}
      {editor.kind === "binding" && project && <SessionBindingForm key={editor.link?.version ?? "new"} board={board} link={editor.link} busy={busy} cancel={closeEditor}
        reload={link => openEditor({ kind: "binding", link })}
        save={params => void mutate("thread.bind", { ...params, projectId: project.id }, msg("会话归属已更新"), () => setEditor(undefined))} />}
      {editor.kind==="policy"&&project&&board.policy&&<PolicyForm project={project} policy={board.policy} busy={busy}
        save={values=>void mutate("project.policy",values,msg("执行与归集设置已保存"),()=>setEditor(undefined))}/>}
      {editor.kind === "task" && project && <TaskForm projectId={project.id} assets={board.assets} task={editor.value}
        initialStatus={editor.status} busy={busy} cancel={closeEditor} save={values => {
          if (!editor.value && values.timing === "now") {
            return mutate<{taskId: string; runId: string}>("task.quickCreate", values, msg("任务已创建并启动"), result => {
              setTaskFilter("all");
              setEditor(undefined);
              openTask(result.taskId, result.runId);
            });
          }
          return mutate("task.save", values, msg("任务已保存"), () => {
            if (!editor.value) setTaskFilter("all");
            setEditor(undefined);
          });
        }} />}
      {editor.kind === "import" && project && <ImportForm busy={busy} save={paths =>
        void mutate("asset.import", { projectId: project.id, paths }, msg("资产已导入"), () => setEditor(undefined))} />}
      {editor.kind === "asset" && <AssetForm asset={editor.value} groups={board.assets.map(item => item.groupName)} busy={busy} save={values =>
        void mutate("asset.save", values, msg("资产已保存"), () => setEditor(undefined))} />}
      {editor.kind === "review" && <ReviewForm files={board.sessions.files?.filter(f=>f.taskId===editor.task.id)} preview={nativeFiles?preview:undefined} task={editor.task} run={editor.run} busy={busy} save={values =>
        void mutate("task.review", values, values.decision === "accept" ? msg("验收通过，任务已完成") : msg("已退回待办"), () => setEditor(undefined))} />}
      {editor.kind === "refine" && <RefineForm task={editor.task} run={editor.run} busy={busy} canStart={canStart} cancel={closeEditor}
        save={values => void mutate<{ id: string }>("task.refine", values, msg("已启动新一轮优化"), result => {
          setEditor(undefined);
          openTask(editor.task.id, result.id);
        })} />}
    </Dialog>}
    <ApprovalInbox ready={ready} changed={refresh}/>
  </Shell>;
}

const previewTicket=isDsh?/^#preview=([0-9a-f-]{36})$/.exec(location.hash)?.[1]:undefined;
createRoot(document.getElementById("root")!).render(previewTicket?<DshFilePreview ticket={previewTicket}/>:<App />);


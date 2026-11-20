import { msg } from "./i18n.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import type { ProjectGroup } from "../panel-layout.ts";
import type { Params, Lifecycle, ProjectListItem, RunStatus, TaskStatus } from "../types.ts";
import { taskStatuses } from "../workflow.ts";
import { groupsBy } from "../grouping.ts";
import type { ActivityWeeks } from "../calendar.ts";
import { Dialog, Empty, Icon, lifecycleLabels, lifecycles, Menu, ModuleIcon, Search, Status, taskLabels } from "./common.tsx";

const pages = [
  { page: "overview", title: "看板", icon: "overview" },
  { page: "tasks", title: "任务", icon: "tasks" },
  { page: "assets", title: "资产", icon: "assets" },
  { page: "sessions", title: "会话", icon: "chat" }
] as const;
export type ProjectPage = typeof pages[number]["page"];
export type Route = { page: "projects" } | { page: ProjectPage; projectId: string; activityWeeks?: ActivityWeeks };
export type ProjectOperations = {
  groups: ProjectGroup[]; arrange: (payload: Params)=>void;
  create: () => void; edit: (item: ProjectListItem) => void; start: (item: ProjectListItem) => void;
  changeLifecycle: (item: ProjectListItem, value: Lifecycle) => void;
};

const railMedia = "(max-width: 680px)";
const portfolioTitle = "项目总览";

function projectState(item: ProjectListItem): { status: TaskStatus | RunStatus; label: string } {
  if (item.lifecycle !== "active") return { status: "todo", label: msg(lifecycleLabels[item.lifecycle]) };
  if (item.liveRunStatus === "recover") return { status: "recover", label: msg("待核对") };
  if (item.liveRunStatus === "running") return { status: "running", label: msg("执行中") };
  if (item.review) return { status: "review", label: msg("待验收") };
  if (item.error) return { status: "error", label: msg("有错误") };
  if (item.running) return { status: "running", label: msg("进行中") };
  if (item.queued) return { status: "queued", label: msg("已排队") };
  if (item.total && item.done === item.total) return { status: "done", label: msg("已完成") };
  if (item.paused) return { status: "paused", label: msg("有暂停") };
  return { status: "todo", label: item.total ? msg("待办") : msg("未开始") };
}

function Progress({ complete, total }: { complete: number; total: number }) {
  const percent = total ? Math.round(complete * 100 / total) : 0;
  return <span className="progress-track" role="progressbar" aria-label={msg("任务完成率")} aria-valuetext={msg("{0} / {1} 项完成", complete, total)}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></span>;
}

export function Shell({ route, projects, scope, setScope, navigate, refresh, busy, collapsed, setCollapsed, operations, composer, children }: {
  route: Route; projects: ProjectListItem[]; scope: Lifecycle;
  setScope: (value: Lifecycle) => void; navigate: (route: Route) => void;
  refresh: () => void; busy: boolean; operations: ProjectOperations; composer: ReactNode; children: ReactNode;
  collapsed: boolean; setCollapsed: (value: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [narrow, setNarrow] = useState(() => window.matchMedia(railMedia).matches);
  const [railOpen, setRailOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const temporary = narrow || collapsed;
  const peeking = temporary && peek && !railOpen;
  const railNode = useRef<HTMLElement>(null);
  const railToggle = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<number>(undefined);
  const workspace = useRef<HTMLElement>(null);
  const projectId = route.page === "projects" ? undefined : route.projectId;
  const project = projects.find(item => item.id === projectId);

  useEffect(() => {
    const media = matchMedia(railMedia);
    const resize = (event: MediaQueryListEvent) => { setNarrow(event.matches); setRailOpen(false); setPeek(false); };
    media.addEventListener("change", resize);
    return () => { media.removeEventListener("change", resize); window.clearTimeout(hideTimer.current); };
  }, []);
  useEffect(() => {
    if (!peeking) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !railNode.current?.contains(event.target) && !railToggle.current?.contains(event.target)) setPeek(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setPeek(false);
        railToggle.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    const dismiss = () => setPeek(false);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", dismiss);
    };
  }, [peeking]);
  useLayoutEffect(() => { workspace.current?.scrollTo(0, 0); }, [route]);

  function closeRail() {
    window.clearTimeout(hideTimer.current);
    if (peeking && railNode.current?.contains(document.activeElement)) railToggle.current?.focus({ preventScroll: true });
    setPeek(false);
    setRailOpen(false);
  }
  function leaveRail() {
    if (!peeking) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      const panel = railNode.current;
      if (!panel?.matches(":hover") && !railToggle.current?.matches(":hover") &&
        !panel?.querySelector(":focus-visible, :popover-open")) setPeek(false);
    }, 200);
  }
  function select(next: Route) { closeRail(); navigate(next); }
  const home = () => select({ page: "projects" });
  const open = (item: ProjectListItem) => select({ page: route.page === "projects" ? "overview" : route.page, projectId: item.id });
  const rail = <ProjectRail projects={projects} scope={scope} setScope={setScope} query={query} setQuery={setQuery}
    selected={projectId} showHome={home} open={open} busy={busy}
    operations={{
      ...operations,
      create: () => { closeRail(); setQuery(""); operations.create(); },
      edit: item => { closeRail(); operations.edit(item); },
      start: item => { closeRail(); operations.start(item); },
      changeLifecycle: (item, value) => { closeRail(); operations.changeLifecycle(item, value); }
    }} />;

  const expanded = peeking || (narrow ? railOpen : !collapsed);
  const toggleLabel = narrow ? msg("打开项目侧栏") : collapsed ? msg("展开项目侧栏") : msg("收起项目侧栏");
  return <div className="app-shell" data-rail-collapsed={!narrow && collapsed}>
    {narrow && railOpen ? <Dialog title={msg("切换项目")} close={closeRail} drawer left>{rail}</Dialog> :
      <aside ref={railNode} className="rail" aria-label={msg("项目侧栏")} hidden={temporary && !peeking} data-floating={peeking}
        onPointerEnter={() => window.clearTimeout(hideTimer.current)} onPointerLeave={leaveRail}>
        <button className="brand" onClick={home} aria-label={msg("MOKI任务台，返回{0}", msg(portfolioTitle))}>
          <span className="brand-icon"><Icon name="brand" size={19} /></span><span>{msg("MOKI任务台")}</span>
        </button>
        {rail}
      </aside>}
    <div className="workspace-main">
      <header className="topbar" data-project={Boolean(projectId)}>
        <div className="workspace-heading">
          <button ref={railToggle} type="button" className="icon-button ghost rail-toggle" aria-label={toggleLabel}
            title={peeking && !narrow ? msg("固定展开项目侧栏") : toggleLabel} aria-expanded={expanded}
            aria-controls="project-navigation" aria-keyshortcuts={temporary ? "ArrowDown" : undefined}
            onPointerEnter={event => {
              window.clearTimeout(hideTimer.current);
              if (temporary && event.pointerType === "mouse") setPeek(true);
            }} onPointerLeave={leaveRail}
            onKeyDown={event => {
              if (!temporary || event.key !== "ArrowDown") return;
              event.preventDefault();
              setPeek(true);
              requestAnimationFrame(() => {
                const target = railNode.current?.querySelector<HTMLButtonElement>(".rail-content button[aria-current='page']") ??
                  railNode.current?.querySelector<HTMLButtonElement>(".portfolio-link");
                target?.focus();
              });
            }}
            onClick={() => { closeRail(); if (narrow) setRailOpen(true); else setCollapsed(!collapsed); }}>
            <Icon name={temporary ? "sidebarOpen" : "sidebarClose"} size={18} />
          </button>
          <h1 className="workspace-title" title={project?.title}>
            <ModuleIcon name={projectId ? "projects" : "portfolio"} small />
            <span className="workspace-name">{projectId ? project?.title ?? msg("项目详情") : msg(portfolioTitle)}</span>
            {projectId && <span className="sr-only"> · {msg(pages.find(item => item.page === route.page)?.title ?? "")}</span>}
          </h1>
          {project?.lifecycle === "active" && <button type="button" className="icon-button ghost heading-edit" title={msg("编辑项目")} aria-label={msg("编辑当前项目")} disabled={busy} onClick={() => operations.edit(project)}>
            <Icon name="compose" size={15}/>
          </button>}
        </div>
        {projectId && <nav className="workspace-tabs" aria-label={msg("项目页面")}>
          {pages.map(({ page, title, icon }) => <button type="button" className="ghost" key={page}
            aria-current={route.page === page ? "page" : undefined}
            onClick={() => select({ page, projectId })}><Icon name={icon} />{msg(title)}</button>)}
        </nav>}
        <button className="icon-button ghost workspace-refresh" onClick={refresh} disabled={busy} aria-label={msg("刷新")} title={msg("刷新")}>
          <Icon name="refresh" />
        </button>
      </header>
      <main className="page" id="workspace" data-page={route.page} ref={workspace}>{children}</main>
      {composer}
    </div>
  </div>;
}

function ProjectRail({ projects, scope, setScope, query, setQuery, selected, showHome, open, operations, busy }: {
  projects: ProjectListItem[]; scope: Lifecycle; setScope: (value: Lifecycle) => void; query: string;
  setQuery: (value: string) => void; selected?: string; showHome: () => void;
  open: (item: ProjectListItem) => void; operations: ProjectOperations; busy: boolean;
}) {
  const counts = { active: 0, archived: 0, trash: 0 };
  for (const item of projects) counts[item.lifecycle]++;
  const term = query.trim().toLocaleLowerCase();
  const results = projects.filter(item => item.lifecycle === scope &&
    `${item.title} ${item.description} ${item.root} ${item.category || msg("未分类")}`.toLocaleLowerCase().includes(term));
  const [drag,setDrag]=useState<{kind:"project";item:ProjectListItem}|{kind:"group";name:string}>();
  const [marker,setMarker]=useState("");
  const groups=operations.groups.map(group=>({group,members:results.filter(item=>item.category===group.name)}))
    .filter(({members,group})=>members.length || (scope==="active" && !term && projects.some(p=>p.lifecycle==="active")));
  function begin(event:DragEvent, value:NonNullable<typeof drag>){
    event.stopPropagation();
    event.dataTransfer.effectAllowed="move";
    event.dataTransfer.setData("application/x-moki-project-layout",value.kind);
    setDrag(value);
  }
  function place(event:DragEvent,name:string,target?:ProjectListItem,drop=false){
    if(!drag||scope!=="active"||busy)return;
    if(target && drag.kind==="group")return;
    event.preventDefault();event.stopPropagation();
    const bounds=event.currentTarget.getBoundingClientRect();
    const after=event.clientY>=bounds.top+bounds.height/2;
    const key=target?"p/"+target.id:"g/"+name;
    setMarker(key+(after?"/after":"/before"));
    if(!drop){event.dataTransfer.dropEffect="move";return;}
    if(drag.kind==="group")operations.arrange({kind:"group",group:drag.name,target:name,after});
    else operations.arrange({kind:"project",group:name,id:drag.item.id,version:drag.item.version,target:target?.id,after});
    setDrag(undefined);setMarker("");
  }
  const dragEnd=()=>{setDrag(undefined);setMarker("");};
  return <div className="rail-content" id="project-navigation">
    <button className="portfolio-link ghost" onClick={showHome} aria-current={selected ? undefined : "page"}
      data-initial-focus={selected ? undefined : true}>
      <Icon name="portfolio" size={18} />{msg(portfolioTitle)}
    </button>
    <div className="rail-tools">
      <div className="row between"><h2>{msg("项目")}</h2>
        <button className="ghost rail-create" onClick={operations.create} disabled={busy}><Icon name="plus" size={15} />{msg("新建项目")}</button>
      </div>
      <Search value={query} change={setQuery} label={msg("搜索项目")} />
      <div className="segments rail-scopes" role="group" aria-label={msg("项目范围")}>
        {lifecycles.map(value => <button type="button" key={value} aria-pressed={value === scope}
          onClick={() => setScope(value)}>{msg(lifecycleLabels[value])} <span className="scope-count">{counts[value]}</span></button>)}
      </div>
    </div>
    <div className="rail-projects" aria-label={msg("项目卡片")}>
      {groups.map(({group,members},index) => <section key={group.name} className="rail-group" data-group={group.name}
        data-drop={marker.startsWith("g/"+group.name+"/")?marker.split("/").at(-1):undefined}
        onDragOver={event=>place(event,group.name)} onDrop={event=>place(event,group.name,undefined,true)}>
        <h3><button className="group-heading ghost" title={group.name||msg("未分类")} aria-expanded={!!term||!group.collapsed}
          draggable={scope==="active"&&!busy} onDragStart={e=>begin(e,{kind:"group",name:group.name})} onDragEnd={dragEnd}
          onKeyDown={e=>{
            if(!e.altKey||scope!=="active"||!["ArrowUp","ArrowDown"].includes(e.key))return;
            const down=e.key==="ArrowDown",neighbor=groups[index+(down?1:-1)];
            if(neighbor){e.preventDefault();operations.arrange({kind:"group",group:group.name,target:neighbor.group.name,after:down});}
          }}
          onClick={()=>operations.arrange({kind:"fold",group:group.name,collapsed:!group.collapsed})}>
          <Icon name={!group.collapsed||term?"down":"right"} size={12}/>{group.name||msg("未分类")}<small>{members.length}</small>
        </button></h3>
        {(!!term||!group.collapsed)&&members.map((item,position) => {
          const state = projectState(item);
          const completion = msg("已完成 {0} / {1} 项任务", item.done, item.total);
          return <article className="rail-project" data-selected={selected === item.id} key={item.id} draggable={item.lifecycle==="active"&&!busy}
            data-drop={marker.startsWith("p/"+item.id+"/")?marker.split("/").at(-1):undefined}
            onDragStart={e=>begin(e,{kind:"project",item})} onDragEnd={dragEnd}
            onDragOver={e=>place(e,group.name,item)} onDrop={e=>place(e,group.name,item,true)}
            onKeyDown={e=>{
              if(!e.altKey||scope!=="active"||!["ArrowUp","ArrowDown"].includes(e.key))return;
              const down=e.key==="ArrowDown",neighbor=members[position+(down?1:-1)];
              if(neighbor){e.preventDefault();operations.arrange({kind:"project",group:group.name,id:item.id,version:item.version,target:neighbor.id,after:down});}
            }}>
            <button className="rail-project-open ghost" onClick={() => open(item)} aria-current={selected === item.id ? "page" : undefined}
              data-initial-focus={selected === item.id || undefined} aria-label={msg("切换到项目 {0}", item.title)}
              aria-description={`${state.label}，${completion}`} title={item.title}>
              <ModuleIcon name="projects" small /><strong title={item.title}>{item.title}</strong>
            </button>
            <ProjectMenu item={item} operations={operations} open={()=>open(item)} busy={busy}/>
            <div className="rail-card-meta">
              <Status {...state} />
              <span className="rail-completion" title={completion}><Progress complete={item.done} total={item.total} />
                <span>{item.done} / {item.total}</span></span>
            </div>
          </article>;
        })}
      </section>)}
      {results.length === 0 && <p className="rail-empty">{term ? msg("没有匹配的项目") : scope === "active" ? msg("暂无活动项目") : msg("暂无{0}中的项目", msg(lifecycleLabels[scope]))}</p>}
    </div>
  </div>;
}

function ProjectMenu({item,operations,open,busy}:{item:ProjectListItem;operations:ProjectOperations;open:()=>void;busy:boolean}){
  return <Menu context label={msg("项目操作 {0}", item.title)}>
              <button onClick={open}>{msg("打开项目")}</button>
              {item.lifecycle === "active" && <>
                <button disabled={busy || Boolean(item.liveRunStatus) || !item.queued} onClick={() => operations.start(item)}>{msg("开始项目")}</button>
                <button disabled={busy} onClick={() => operations.edit(item)}>{msg("编辑项目")}</button>
                {operations.groups.length>1 && <label className="menu-select">{msg("移动到分类")}<select aria-label={msg("移动到分类")} value={item.category} onChange={e=>operations.arrange({kind:"project",id:item.id,version:item.version,group:e.target.value})}>
                  {operations.groups.map(g=><option key={g.name} value={g.name}>{g.name||msg("未分类")}</option>)}</select></label>}
                <button disabled={busy || Boolean(item.liveRunStatus)} onClick={() => operations.changeLifecycle(item, "archived")}>{msg("归档项目")}</button>
              </>}
              {item.lifecycle !== "active" && <button disabled={busy} onClick={() => operations.changeLifecycle(item, "active")}>{msg("恢复项目")}</button>}
              {item.lifecycle !== "trash" && <button className="danger" disabled={busy || Boolean(item.liveRunStatus)}
                onClick={() => operations.changeLifecycle(item, "trash")}>{msg("删除项目")}</button>}
            </Menu>;
}

export function Portfolio({ projects, scope, open,operations,busy }: {
  operations:ProjectOperations;busy:boolean;
  projects: ProjectListItem[]; scope: Lifecycle; open: (id: string) => void;
}) {
  const counts = { todo: 0, queued: 0, running: 0, review: 0, done: 0, error: 0, paused: 0 };
  const active = projects.filter(item => item.lifecycle === "active");
  const [category, setCategory] = useState("");
  const scoped = projects.filter(item => item.lifecycle === scope);
  const categories = groupsBy(scoped, item => item.category);
  const selected = categories.some(([name]) => category === "group/" + name) ? category : "";
  const items = selected ? scoped.filter(item => "group/" + item.category === selected) : scoped;
  let total = 0;
  let executing = 0;
  for (const item of active) {
    total += item.total;
    if (item.liveRunStatus === "running") executing++;
    for (const status of taskStatuses) counts[status] += item[status];
  }
  const metrics = [
    { label: msg("活动项目"), icon: "projects", value: active.length },
    { label: msg("执行中项目"), icon: "play", value: executing, status: "running" },
    { label: msg("待验收任务"), icon: "task", value: counts.review, status: "review" },
    { label: msg("整体完成率"), icon: "check", value: `${total ? Math.round(counts.done * 100 / total) : 0}%`, status: "done" }
  ] as const;

  return <div className="page-content portfolio-page" role="region" aria-label={msg("项目总览内容")}>
    <div className="metrics" aria-label={msg("跨项目统计")}>
      {metrics.map(metric => <div className="metric" key={metric.label} data-status={"status" in metric ? metric.status : undefined}>
        <span>{metric.label}<Icon name={metric.icon} size={18} /></span><strong>{metric.value}</strong>
      </div>)}
    </div>
    <section className="panel progress-panel portfolio-flow">
      <div className="section-heading"><h2>{msg("活动任务分布")}</h2><span className="muted">{total} {msg("项任务 ·")} {counts.done} {msg("项完成")}</span></div>
      <div className="distribution" role="img" aria-label={taskStatuses.map(status => msg("{0} {1} 项", msg(taskLabels[status]), counts[status])).join("，")}>
        {taskStatuses.filter(status => counts[status]).map(status => <span key={status} data-status={status} style={{ flex: counts[status] }} />)}
      </div>
      <div className="flow-legend">
        {taskStatuses.map(status => <div key={status}><Status status={status} /><strong>{counts[status]}</strong></div>)}
      </div>
    </section>
    <section className="portfolio-projects">
      <div className="section-heading"><h2>{scope === "active" ? msg("项目进度") : msg("{0}项目", msg(lifecycleLabels[scope]))}</h2>
        <div className="row category-filter">
          <select aria-label={msg("按项目分类筛选")} value={selected} onChange={event => setCategory(event.target.value)}>
            <option value="">{msg("全部分类")}</option>
            {categories.map(([name]) => <option key={name} value={"group/" + name}>{name || msg("未分类")}</option>)}
          </select>
          <span className="muted">{items.length} {msg("个项目")}</span>
        </div></div>
      {items.length ? <div key={scope + "/" + selected} className="portfolio-table" role="region" aria-label={msg("项目进度列表")} tabIndex={0}>
        <div className="portfolio-columns" aria-hidden="true"><span>{msg("项目")}</span><span>{msg("状态")}</span><span>{msg("任务进度")}</span><span>{msg("队列")}</span><span>{msg("待验收")}</span><span /></div>
        {items.map(item => <article className="portfolio-entry" key={item.id}><button className="portfolio-row" onClick={() => open(item.id)}
          aria-label={msg("打开项目 {0}", item.title)} aria-description={msg("{0}，{1} / {2} 项完成", projectState(item).label, item.done, item.total)}>
          <span className="portfolio-project"><ModuleIcon name="projects" small /><span><strong title={item.title}>{item.title}</strong>
            {item.description && <small title={item.description}>{item.description}</small>}</span></span>
          <Status {...projectState(item)} />
          <span className="portfolio-progress"><Progress complete={item.done} total={item.total} /><span>{item.done} / {item.total}</span></span>
          <span className="portfolio-count">{item.queued}</span><span className="portfolio-count">{item.review}</span>
          <span aria-hidden="true"/>
        </button><ProjectMenu item={item} busy={busy} operations={operations} open={()=>open(item.id)}/></article>)}
      </div> : <Empty title={scope === "active" ? msg("还没有项目") : msg("此范围暂无项目")} />}
    </section>
  </div>;
}


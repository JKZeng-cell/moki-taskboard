import { msg, uiLocale } from "./i18n.ts";
import { hostName } from "../host-identity.ts";
import { SessionMarkdown } from "./session-markdown.tsx";
import { ConversationFiles } from "./conversation-files.tsx";
import { CaptureEvidence } from "./capture-evidence.tsx";
import { FileIcon } from "./file-icon.tsx";
import { useId, useMemo, useState } from "react";
import type { BoardState, Params, Task } from "../types.ts";
import type { Link } from "../capture.ts";
import { Empty, Icon, Menu, Notice, runLabels, Search, Status, timestamp } from "./common.tsx";
import { excerptText, inScope, projectSessions, type SessionEntry, type SessionScope } from "./session-list.ts";

const scopes = [
  { id: "linked", title: "已关联", empty: "暂无关联会话" },
  { id: "pending", title: "待归属", empty: "没有待归属的会话" },
  { id: "ignored", title: "已忽略", empty: "没有已忽略的会话" },
] as const;

const origins = { manual: "手动绑定", auto: "目录匹配", candidate: "目录匹配", ignored: "已忽略" };

const originOf = (link: Link) => link.matchBasis === "semantic" && (link.kind === "auto" || link.kind === "candidate")
  ? (link.kind === "auto" ? msg("语义匹配") : msg("语义待确认")) : msg(origins[link.kind]);

type Actions = {
  open: (taskId: string, runId?: string) => void;
  session: (runId: string) => void;
  jump: (threadId: string) => void;
  preview?: (versionId: string) => void;
  bind: (link?: Link) => void;
  change: (params: Params) => void;
};

type Props = Actions & {
  board: BoardState;
  busy: boolean;
  scan: () => void;
  policy: () => void;
};

export function SessionsPage({ board, busy, scan, policy, ...actions }: Props) {
  const [scope, setScope] = useState<SessionScope>("linked");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const editable = board.project?.lifecycle === "active";
  const { entries, tasks } = useMemo(() => projectSessions(board), [board, uiLocale()]);
  const term = query.trim().toLocaleLowerCase();
  const visible = entries.filter(entry => inScope(entry, scope) && (!term || entry.searchText.includes(term)));
  const current = scopes.find(item => item.id === scope)!;
  function selectScope(next: SessionScope) {
    setScope(next);
    setExpanded(undefined);
  }

  return <section className="page-content list-page sessions-page" aria-label={msg("项目会话")}>
    <header className="list-toolbar session-toolbar" aria-label={msg("会话工具栏")}>
      <Search label={msg("搜索会话")} value={query} change={setQuery} />
      {editable && <div className="list-actions">
        <button className="ghost" onClick={policy} title={msg("归集设置")} aria-label={msg("归集设置")}><Icon name="settings" /><span>{msg("归集设置")}</span></button>
        {board.policy?.capture && <button onClick={scan} disabled={busy}><Icon name="refresh" />{msg("扫描会话")}</button>}
        <button className="primary" onClick={() => actions.bind()} disabled={busy}><Icon name="plus" />{msg("绑定会话")}</button>
      </div>}
    </header>
    <div className="session-scopes" role="group" aria-label={msg("会话范围")}>
      {scopes.map(item => <button key={item.id} aria-pressed={scope === item.id} onClick={() => selectScope(item.id)}>
        {msg(item.title)}<span>{entries.filter(entry => inScope(entry, item.id)).length}</span>
      </button>)}
      {term && <small role="status">{visible.length} {msg("项匹配")}</small>}
    </div>
    <Notice error={board.scanError} />
    {board.semantics && board.semantics.pending > 0 && <p className="session-recognition" role="status"><Icon name="chat" size={14} />
      {board.semantics.error ? msg("语义识别等待重试 · {0}", board.semantics.error) : msg("正在识别 {0} 个会话", board.semantics.pending)}</p>}
    {visible.length ? <div className="session-list" data-scope={scope} role="region" aria-label={msg("{0}会话", msg(current.title))}>
      {visible.map(entry => <SessionRow key={entry.id} entry={entry} projectId={board.project!.id} tasks={tasks} scope={scope} busy={busy}
        editable={editable} expanded={expanded === entry.id} toggle={() => setExpanded(expanded === entry.id ? undefined : entry.id)}
        actions={actions} />)}
    </div> : <Empty icon="chat" title={term ? msg("没有匹配的会话") : msg(current.empty)}>
      {term ? <button className="text-button" onClick={() => setQuery("")}>{msg("清除搜索")}</button> :
        scope === "linked" ? msg("任务执行产生的会话和已绑定的聊天会显示在这里。") :
        scope === "pending" ? msg("会话归属需要确认时，可在这里选择项目。") : null}
    </Empty>}
  </section>;
}

function SessionRow({ entry, projectId, tasks, scope, busy, editable, expanded, toggle, actions }: {
  entry: SessionEntry; projectId: string; tasks: Map<string, Task>; scope: SessionScope;
  busy: boolean; editable: boolean; expanded: boolean; toggle: () => void; actions: Actions;
}) {
  const { link, runs, activity, summary, title } = entry;
  const newest = runs[0];
  const detailId = useId();
  const runOrigin = runs.length > 1 ? msg("{0} 次任务执行", runs.length) : msg("任务执行");
  const origin = newest && scope === "linked" ? runOrigin : link ? originOf(link) : runOrigin;
  const showCaptureActions = editable && link && (scope !== "linked" || link.kind === "manual" || link.kind === "auto");
  const operate = (operation?: "ignore" | "undo") =>
    link && actions.change({ threadId: entry.id, version: link.version, operation });
  const openSession = () => newest ? actions.session(newest.id) : actions.jump(entry.id);
  const iso = activity > 0 ? new Date(activity).toISOString() : "";
  return <article className="session-entry" aria-label={title} data-expanded={expanded}>
    <div className="session-line">
      <button type="button" className="ghost session-summary" onClick={toggle}
        aria-label={msg("会话详情 {0}", title)} aria-expanded={expanded} aria-controls={expanded ? detailId : undefined}>
        <span className="session-icon" data-status={scope === "pending" ? "review" : undefined} data-origin={scope === "pending" ? "pending" : newest ? "run" : "link"}><Icon name="chat" size={18} /></span>
        <span className="session-copy">
          <strong title={title}>{title}</strong>
          {!expanded && summary && summary !== title && <span className="session-excerpt">{excerptText(summary)}</span>}
          <span className="session-meta"><span>{origin}</span>
            {newest && <Status status={newest.status} label={msg(runLabels[newest.status])} />}
            {entry.sources.length > 0 && <span>{entry.sources.length} {msg("条归集记录")}</span>}
            {!!entry.files.length && <span>{entry.files.length} {msg("条文件记录")}</span>}
            {iso && <time dateTime={iso}>{timestamp(iso)}</time>}
          </span>
        </span>
        <Icon name="right" size={14} />
      </button>
      <div className="session-actions">
        {showCaptureActions && scope === "pending" && <button disabled={busy} onClick={() => operate()}>{msg("归入本项目")}</button>}
        {showCaptureActions && scope === "ignored" && <button disabled={busy} onClick={() => actions.bind(link)}>{msg("恢复绑定")}</button>}
        <button className="ghost session-jump" onClick={openSession} aria-label={msg("打开会话 {0}", title)} title={msg("在 {0} 中打开会话", hostName)}>
          <Icon name="external" size={15} /><span>{msg("打开会话")}</span>
        </button>
        {showCaptureActions && scope !== "ignored" && <Menu label={msg("会话操作 {0}", title)}>
          <button onClick={() => actions.bind(link)} disabled={busy}>{msg("调整归属")}</button>
          {scope === "pending" ? <button onClick={() => operate("ignore")} disabled={busy}>{msg("忽略")}</button> :
            <button onClick={() => operate("undo")} disabled={busy}>{msg("撤销归集")}</button>}
        </Menu>}
      </div>
    </div>
    {expanded && <div className="session-details" id={detailId}>
      <dl className="session-identifiers">
        <dt>{msg("会话 ID")}</dt><dd><code>{entry.id}</code></dd>
        {newest && link && (link.kind === "auto" || link.kind === "manual") && <><dt>{msg("关联方式")}</dt><dd>{originOf(link)}</dd></>}
        {link?.matchReason && <><dt>{msg("归属依据")}</dt><dd>{link.matchReason}</dd></>}
        {link?.matchQuote && <><dt>{msg("用户原话")}</dt><dd>{link.matchQuote}</dd></>}
        {link?.cwd && <><dt>{msg("工作目录")}</dt><dd>{link.cwd}</dd></>}
        {link?.taskId && tasks.has(link.taskId) && <><dt>{msg("绑定任务")}</dt><dd><button className="text-button" onClick={() => actions.open(link.taskId!)}>
          {tasks.get(link.taskId)!.title}</button></dd></>}
      </dl>
      {summary && <SessionMarkdown key={entry.id + "/" + summary} summary={summary} threadId={entry.id} projectId={projectId}
        nativeFiles={Boolean(actions.preview)} completeExcerpt={link?.summary === summary && summary.length === 360 && (link.kind === "auto" || link.kind === "manual")} />}
      {runs.length > 0 && <section className="session-history"><h3>{msg("任务执行")}</h3>
        {runs.map(run => <div key={run.id} className="session-record">
          <Icon name="task" size={15} /><button className="text-button" onClick={() => actions.open(run.taskId, run.id)}>
            {tasks.get(run.taskId)?.title || msg("查看任务")}</button>
          <span>{msg(run.phase) || msg(runLabels[run.status])} · {timestamp(run.startedAt)}</span>
        </div>)}
      </section>}
      {entry.sources.length > 0 && <section className="session-history"><h3>{msg("归集记录")}</h3>
        {entry.sources.map(source => <div key={source.turnId + "/" + source.anchor} className="session-record">
          <Icon name="link" size={15} />
          {source.taskId && tasks.has(source.taskId) ? <button className="text-button" onClick={() => actions.open(source.taskId!)}>{source.title}</button> : <strong>{source.title}</strong>}
          <span title={source.turnId}>{msg("来源回合")} {source.turnId.slice(0, 8)}</span>
          <CaptureEvidence source={source} jump={actions.jump} />
        </div>)}
      </section>}
      {entry.files.length > 0 && <section className="session-history"><h3>{msg("会话资料与产物")}</h3>
        <ConversationFiles files={entry.files} preview={actions.preview}/>
      </section>}
      {entry.refs.length > 0 && <section className="session-history"><h3>{msg("引用资产")}</h3>
        {entry.refs.map(ref => <div className="session-record" key={ref.turnId + "/" + ref.versionId}>
          <FileIcon name={ref.path} size={15} />
          {actions.preview ? <button className="text-button" title={ref.path} onClick={() => actions.preview?.(ref.versionId)}>{ref.path} · v{ref.revision}</button> :
            <strong>{ref.path} · v{ref.revision}</strong>}
        </div>)}
      </section>}
    </div>}
  </article>;
}

import { msg, systemText, uiLocale } from "./i18n.ts";
import { ConversationFiles } from "./conversation-files.tsx";
import { FileIcon } from "./file-icon.tsx";
import { useMemo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { assetMatches, taskAssetGroups, type AssetGroup } from "./asset-groups.ts";
import { sessionAssetGroups } from "./asset-sessions.ts";
import type { Asset, AssetView, BoardState, ConversationFile, Lifecycle } from "../types.ts";
import { fileExtension, fileType, groupsBy } from "../grouping.ts";
import { Empty, Icon, lifecycleLabels, lifecycles, Menu, Search, timestamp } from "./common.tsx";

const roles = { user: "导入文件", output: "任务产物", handoff: "交接文件" };
function sizeOf(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function AssetsPage({ board,jump,view, setView, handoff, editable, nativeFiles, busy, add, edit, content, resume, drafts, refreshSource, preview, changeLifecycle }: {
  board: BoardState; jump:(threadId:string)=>void;
  view: AssetView; setView: (view: AssetView) => void;
  drafts:Set<string>; content:(asset:Asset)=>void; resume:(asset:Asset)=>void; refreshSource:(asset:Asset)=>void;
  handoff: string | null; editable: boolean; nativeFiles: boolean; busy: boolean;
  add: () => void; edit: (asset: Asset) => void; preview: (versionId: string) => void;
  changeLifecycle: (asset: Asset, value: Lifecycle) => void;
}) {
  const [scope, setScope] = useState<Lifecycle>("active");
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState("type");
  const term = query.trim().toLocaleLowerCase();
  const scoped = useMemo(() => board.assets.filter(asset => asset.lifecycle === scope), [board.assets, scope]);
  const related = useMemo(() => {
    if (grouping === "task") return taskAssetGroups(board, scoped, term);
    if (grouping === "session") return sessionAssetGroups(board, scoped, term);
    return null;
  }, [board, scoped, term, grouping, uiLocale()]);
  const matching = related ? [] : scoped.filter(asset => assetMatches(asset, term));
  const count = related?.count ?? matching.length;
  const groups = grouping === "type" || grouping === "custom" ? groupsBy(matching, asset =>
    grouping === "custom" ? asset.groupName : systemText(fileType(asset.versions[0]?.fileName ?? asset.name))) : [];
  const fileIndex = useMemo(() => {
    const index = new Map<string, ConversationFile[]>();
    for (const file of board.sessions.files ?? []) {
      if (!file.assetId) continue;
      const group = index.get(file.assetId);
      if (group) group.push(file); else index.set(file.assetId, [file]);
    }
    return index;
  }, [board.sessions.files]);
  const renderAssets = (items: Asset[]) => <div className={view === "cards" ? "asset-grid" : undefined}>
    {items.map(asset => <AssetRow files={fileIndex.get(asset.id) ?? []} jump={jump} key={asset.id} asset={asset} view={view}
    isHandoff={asset.versions.some(version => version.id === handoff)} nativeFiles={nativeFiles} preview={preview}
    hasDraft={drafts.has(asset.id)} content={()=>content(asset)} resume={()=>resume(asset)} refreshSource={()=>refreshSource(asset)} edit={() => edit(asset)} editable={editable} busy={busy} changeLifecycle={value => changeLifecycle(asset, value)} />)}
  </div>;
  return <div className="page-content list-page assets-page">
    <header className="list-toolbar" aria-label={msg("资产工具栏")}>
      <div className="filters">
        <Search label={grouping === "task" ? msg("搜索资产或任务") : grouping === "session" ? msg("搜索资产或会话") : msg("搜索资产")} value={query} change={setQuery} />
        <label className="sr-only" htmlFor="asset-scope">{msg("资产范围")}</label>
        <select id="asset-scope" value={scope} onChange={event => setScope(event.target.value as Lifecycle)}>
          {lifecycles.map(value => <option key={value} value={value}>{msg(lifecycleLabels[value])}</option>)}
        </select>
        <select aria-label={msg("资料分组方式")} value={grouping} onChange={event => setGrouping(event.target.value)}>
          <option value="type">{msg("按文件类型")}</option><option value="task">{msg("按任务分组")}</option><option value="session">{msg("按会话分组")}</option><option value="custom">{msg("按自定义分组")}</option><option value="none">{msg("不分组")}</option>
        </select>
      </div>
      <div className="list-actions">
        <span className="list-count" role="status">{count} {term ? msg("项匹配") : msg("项资产")}</span>
        <div className="segments" role="group" aria-label={msg("资产视图")}>
          <button type="button" aria-pressed={view === "list"} disabled={busy} onClick={() => view !== "list" && setView("list")}><Icon name="table" />{msg("列表")}</button>
          <button type="button" aria-pressed={view === "cards"} disabled={busy} onClick={() => view !== "cards" && setView("cards")}><Icon name="cards" />{msg("卡片")}</button>
        </div>
        {editable && <button className="primary" onClick={add}><Icon name="plus" />{msg("导入资产")}</button>}
      </div>
    </header>
    {count ? <section className={view === "cards" ? "asset-gallery" : "asset-table"} aria-label={view === "cards" ? msg("资产卡片") : msg("资产列表")}>
      {view === "list" && <div className="asset-columns" aria-hidden="true"><span>{msg("名称")}</span><span>{msg("来源与用途")}</span><span>{msg("版本")}</span><span>{msg("操作")}</span></div>}
      {related ? related.groups.map((group, index) => <RelatedGroup key={grouping + "/" + group.id + "/" + term} group={group} initialOpen={Boolean(term) || index === 0} render={renderAssets} />)
       : grouping === "none" ? renderAssets(matching) : groups.map(([name, members]) =>
        <details className="asset-group" key={grouping + "/" + name} open>
          <summary>{name || msg("未分组")}<small>{members.length}</small></summary>{renderAssets(members)}
        </details>)}
    </section> : <Empty icon="file" title={term ? msg("没有匹配的资产") : scope === "active" ? msg("还没有项目资产") : msg("此范围暂无资产")}>
      {!term && scope === "active" && msg("导入文件后，可将指定版本关联到任务。")}
    </Empty>}
  </div>;
}

function RelatedGroup({ group, initialOpen, render }: { group: AssetGroup; initialOpen: boolean; render: (assets: Asset[]) => ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return <details className="asset-group asset-related" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary title={group.id || group.title}><span>{group.title}</span>{group.hint && <code>{group.hint}</code>}
      {group.lifecycle && group.lifecycle !== "active" && <small>{msg(lifecycleLabels[group.lifecycle])}</small>}<small>{group.assets.length}</small></summary>
    {open && render(group.assets)}
  </details>;
}

function AssetRow({ files,jump,view, asset, isHandoff, nativeFiles, editable, busy, edit, hasDraft,content,resume,refreshSource, preview, changeLifecycle }: {
  files:ConversationFile[]; jump:(threadId:string)=>void;
  view: AssetView;
  hasDraft:boolean; content:()=>void; resume:()=>void; refreshSource:()=>void;
  asset: Asset; isHandoff: boolean; nativeFiles: boolean; editable: boolean; busy: boolean;
  edit: () => void; preview: (version: string) => void; changeLifecycle: (value: Lifecycle) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = asset.versions[0];
  const first = asset.versions.at(-1);
  const card = view === "cards";
  const material=files.some(f=>f.role==="material"), output=files.some(f=>f.role==="output");
  const extension = card ? fileExtension(latest?.fileName ?? asset.name) : "";
  function previewRow(event: MouseEvent<HTMLElement>, versionId: string | undefined) {
    if (!nativeFiles || !versionId || event.defaultPrevented || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, a, summary, input, select, textarea, .menu")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) return;
    preview(versionId);
  }
  return <article className={card ? "asset-row asset-card" : "asset-row"} aria-label={asset.name}>
    <div className="asset-line" data-previewable={nativeFiles && Boolean(latest)} onClick={event => previewRow(event, latest?.id)}>
      <div className="asset-name">
        <FileIcon name={latest?.fileName ?? asset.name} size={card ? 23 : 17} tile />
        <div><strong title={asset.name}>{asset.name}</strong>
          {asset.sourcePath && (!card || asset.sourcePath !== asset.name) && <p title={asset.sourcePath}>{asset.sourcePath}</p>}
          {latest && first && <div className="asset-dates"><span>{latest.id === first.id ? msg("加入 / 更新") : msg("加入")} <time dateTime={first.createdAt}>{timestamp(first.createdAt)}</time></span>
            {latest.id !== first.id && <span>{msg("更新")} <time dateTime={latest.createdAt}>{timestamp(latest.createdAt)}</time></span>}</div>}</div>
      </div>
      {card && latest && <div className="asset-card-meta">
        {extension && <span>{extension}</span>}<span>{sizeOf(latest.size)}</span>
      </div>}
      <div className="asset-kind">
        <span className="tag">{asset.role==="user" && material ? msg("会话资料") : msg(roles[asset.role])}</span>
        {asset.role!=="user" && material && <span className="tag">{msg("会话资料")}</span>}
        {asset.role!=="output" && output && <span className="tag">{msg("会话产物")}</span>}
        {Boolean(asset.context) && <span className="tag">{msg("项目上下文")}</span>}
        {isHandoff && <span className="tag highlighted">{msg("当前交接")}</span>}
      </div>
      {latest ? <button className="ghost version-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
        aria-label={msg("版本记录 {0}", asset.name)}>
        v{latest.revision}<span className="muted"> · {asset.versions.length} {msg("个版本")}</span><Icon name="down" size={12} />
      </button> : <span />}
      <div className="row asset-controls">
        {latest && nativeFiles && <button className="ghost" aria-label={msg("预览资产 {0} v{1}", asset.name, latest.revision)}
          onClick={() => preview(latest.id)}><Icon name="eye" size={16} /><span>{msg("预览")}</span></button>}
        {editable && asset.lifecycle !== "active" && <button className="ghost" onClick={() => changeLifecycle("active")} disabled={busy}>{msg("恢复资产")}</button>}
        {(editable || latest) && <Menu context label={msg("资产操作 {0}", asset.name)}>{origin => {
          const id = origin?.closest<HTMLElement>("[data-asset-version]")?.dataset.assetVersion;
          const version = id ? asset.versions.find(item => item.id === id) : latest;
          return <>
            {nativeFiles && version && <button onClick={() => preview(version.id)}>{msg("预览文件 · v")}{version.revision}</button>}
            {latest && <button onClick={() => setExpanded(!expanded)}>{expanded ? msg("收起版本记录") : msg("查看版本记录")}</button>}
            {editable && (asset.lifecycle === "active" ? <>
              <button onClick={content} disabled={busy || !latest}>{msg("编辑文件内容")}</button>
              {hasDraft && <button onClick={resume} disabled={busy}>{msg("继续编辑副本")}</button>}
              {asset.role === "user" && <button onClick={refreshSource} disabled={busy}>{msg("从源文件更新")}</button>}
              <button onClick={edit} disabled={busy}>{msg("编辑资产信息")}</button>
              <button onClick={() => changeLifecycle("archived")} disabled={busy}>{msg("归档资产")}</button>
              <button className="danger" onClick={() => changeLifecycle("trash")} disabled={busy}>{msg("删除资产")}</button>
            </> : <button onClick={() => changeLifecycle("active")} disabled={busy}>{msg("恢复资产")}</button>)}
          </>;
        }}</Menu>}
      </div>
    </div>
    {expanded && <div className="asset-versions">
      {asset.versions.map(version => <div className="asset-version" key={version.id} data-asset-version={version.id} data-previewable={nativeFiles}
        onClick={event => previewRow(event, version.id)}>
        <span className="tag">v{version.revision}</span>
        <span className="version-name" title={version.fileName}><FileIcon name={version.fileName} size={13}/> {version.fileName}</span>
        <span className="muted version-meta" title={`SHA-256 ${version.sha256}`}>{sizeOf(version.size)} · <time dateTime={version.createdAt}>{timestamp(version.createdAt)}</time></span>
        {nativeFiles && <button className="ghost" aria-label={msg("预览历史版本 {0} v{1}", asset.name, version.revision)}
          onClick={() => preview(version.id)}>{msg("预览")}</button>}
      </div>)}
      {files.length>0 && <details><summary>{msg("来源会话 ·")} {files.length}</summary><ConversationFiles files={files} jump={jump}/></details>}
    </div>}
  </article>;
}

import { msg } from "./i18n.ts";
import { hostName } from "../host-identity.ts";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Asset, ConversationFile, PermissionOption, ModelOption, Params, Project, Run, Task, TaskStatus } from "../types.ts";
import { automatic, SessionSelect } from "./execution-session.tsx";
import type { SessionChoice } from "../types.ts";
import { taskStatuses } from "../workflow.ts";
import { action, pick, requestKey } from "./bridge.ts";
import { AttachmentButtons, AttachmentList, useTaskAttachments } from "./task-attachments.tsx";
import type { Policy } from "../schedule.ts";
import { PolicyFields } from "./policy-form.tsx";
import { Acceptance } from "./acceptance.tsx";
import { Disclosure, effortLabel, Icon, taskLabels } from "./common.tsx";

type Submit = (values: Params) => void;

const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const val = (data: FormData, key: string) => String(data.get(key) ?? "");

function GroupField({ label, name, value, options }: { label: string; name: string; value?: string; options: string[] }) {
  const list = useId();
  return <label>{label}
    <input name={name} list={list} maxLength={60} defaultValue={value} placeholder={msg("输入新名称或选择已有名称")} />
    <datalist id={list}>{[...new Set(options.filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"))
      .map(option => <option key={option} value={option} />)}</datalist>
  </label>;
}

export function ProjectForm({ project, categories, save, busy }: { project?: Project; categories: string[]; save: Submit; busy: boolean }) {
  const [root, setRoot] = useState(project?.root ?? "");
  const [policy, setPolicy] = useState<Policy>();
  const [initialPolicy, setInitialPolicy] = useState<Policy>();
  const [permission,setPermission] = useState(project?.permission ?? "default");
  const [permissions,setPermissions] = useState<PermissionOption[]>([]);
  const [permissionError,setPermissionError] = useState("");
  const [policyError, setPolicyError] = useState("");
  const [policyAttempt, setPolicyAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    if (project) action<Policy>("project.policyRead",{id:project.id})
      .then(value=>{if(current){setPolicy(value);setInitialPolicy(value);setPolicyError("");}})
      .catch((error:Error)=>{if(current)setPolicyError(error.message);});
    return ()=>{current=false;};
  }, [project?.id,policyAttempt]);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const [model, setModel] = useState(project?.preferredModel || "");
  const [effort, setEffort] = useState(project?.preferredEffort || "");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let reading = false;
    async function sync() {
      if (document.hidden || reading) return;
      reading = true;
      try {
        const items = await action<ModelOption[]>("models.list");
        if (active) { setModels(items); setCatalogError(""); }
      } catch (error) { if (active) setCatalogError((error as Error).message); }
      finally { reading = false; }
    }
    void sync();
    const timer = window.setInterval(sync, 60000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [attempt]);
  useEffect(() => {
    let active=true;
    action<PermissionOption[]>("permissions.list").then(items=>{if(active){setPermissions(items);setPermissionError("");}})
      .catch((error:Error)=>{if(active)setPermissionError(error.message);});
    return ()=>{active=false;};
  },[attempt]);
  const defaultModel = models.find(item => item.isDefault) ?? models[0];
  const selected = model ? models.find(item => item.id === model) : defaultModel;
  const choose = async () => {
    setPicking(true);
    setError("");
    try { const [path] = await pick("directory"); if (path) setRoot(path); }
    catch (error) { setError(String(error)); }
    finally { setPicking(false); }
  };
  return <form className="project-form" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save({ id: project?.id, version: project?.version, title: val(data, "title"), root, description: val(data, "description"),
      category: val(data, "category"), permission, preferredModel: model || null, preferredEffort: effort || null,
      ...(policy && JSON.stringify(policy)!==JSON.stringify(initialPolicy) ? {policy} : {}) });
  }}>
    <label>{msg("项目名称")}<input name="title" required maxLength={160} defaultValue={project?.title} data-initial-focus /></label>
    <GroupField label={msg("项目分类")} name="category" value={project?.category} options={categories} />
    <label>{msg("项目目标")}<textarea name="description" rows={3} defaultValue={project?.description} maxLength={8000} /></label>
    <div className="field-action">
      <label>{msg("项目目录")}<input name="root" required value={root} onChange={event => setRoot(event.target.value)} placeholder={msg("输入本机绝对路径")} /></label>
      <button type="button" onClick={choose} disabled={picking}>{picking ? msg("等待选择") : msg("选择目录")}</button>
    </div>
    <fieldset className="project-preferences">
      <legend>{msg("执行偏好")}</legend>
      <div className="two">
        <label>{msg("优先模型")}
          <select value={model} onChange={event => {
            const next = event.target.value;
            const nextModel = models.find(item => item.id === next) ?? defaultModel;
            setModel(next);
            if (!nextModel?.efforts.includes(effort)) setEffort("");
          }}>
            <option value="">{hostName} {msg("默认")}{defaultModel ? ` · ${defaultModel.label}` : ""}</option>
            {model && !selected && <option value={model}>{model}{models.length ? msg("（当前不可用）") : ""}</option>}
            {models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>{msg("推理强度")}
          <select value={effort} onChange={event => setEffort(event.target.value)}>
            <option value="">{msg("模型默认")}{selected?.defaultEffort ? ` · ${effortLabel(selected.defaultEffort)}` : ""}</option>
            {effort && !selected?.efforts.includes(effort) && <option value={effort}>{effortLabel(effort)}{models.length ? msg("（当前不可用）") : ""}</option>}
            {selected?.efforts.map(level => <option key={level} value={level}>{effortLabel(level)}</option>)}
          </select>
        </label>
      </div>
      <label>{msg("项目默认权限")}
        <select value={permission} onChange={event=>setPermission(event.target.value)}>
          {!permissions.some(option=>option.value===permission) && <option value={permission}>{permission==="default"?msg("默认权限"):permission}</option>}
          {permissions.map(option=><option key={option.value} value={option.value}>{msg(option.name)}</option>)}
        </select>
      </label>
      <p className="muted">{msg(permissions.find(option=>option.value===permission)?.description ?? "")} {msg("权限在任务启动时确定。")}</p>
      {permissionError && <p role="alert">{permissionError} <button type="button" onClick={()=>setAttempt(n=>n+1)}>{msg("重试")}</button></p>}
      {catalogError ? <div className="catalog-status"><span role="alert">{catalogError}</span>
        <button type="button" className="text-button" onClick={() => setAttempt(count => count + 1)}>{msg("重新获取模型")}</button></div> :
        !models.length && <p className="muted" role="status">{msg("正在获取")} {hostName} {msg("模型…")}</p>}
    </fieldset>
    {project && <Disclosure title={msg("调度与归集")} icon="settings" meta={policy ? ({manual:msg("手动"),auto:msg("自动"),window:msg("时段")}[policy.mode]) : undefined}>
      {policy ? <PolicyFields key={project.id} project={{id:project.id,root}} value={policy} change={setPolicy}/> :
        policyError ? <div role="alert">{policyError} <button type="button" onClick={()=>setPolicyAttempt(n=>n+1)}>{msg("重试")}</button></div> : <p role="status">{msg("正在读取项目设置…")}</p>}
    </Disclosure>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions"><button className="primary" disabled={busy || picking}>{msg("保存项目")}</button></div>
  </form>;
}

export function TaskForm({ projectId, task, initialStatus = "todo", assets, save, cancel, busy }: {
  projectId: string; task?: Task; initialStatus?: TaskStatus; assets: Asset[]; save: (values: Params) => Promise<void>;
  cancel: () => void; busy: boolean;
}) {
  const draft = useTaskAttachments();
  const [uploading, setUploading] = useState(false);
  const submitting = useRef(false);
  const [status, setStatus] = useState<TaskStatus | "now">(initialStatus);
  const immediate = !task && status === "now";
  const [choice, setChoice] = useState<SessionChoice>(automatic);
  const lastStart = useRef<{ signature: string; key: string }>(undefined);
  const [checkError, setCheckError] = useState("");
  const checkInput = useRef<HTMLTextAreaElement>(null);
  const checkErrorId = useId();
  const available = assets.flatMap(asset => asset.versions
    .filter(version => asset.lifecycle === "active" || task?.inputVersionIds.includes(version.id))
    .map(version => ({ version, name: asset.name })));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || busy || draft.readingClipboard) return;
    submitting.current=true; setUploading(true);
    const data = new FormData(event.currentTarget);
    try {
      const textChecks = lines(val(data, "checks")).map(row => {
        const divider = row.indexOf("|");
        if (divider < 1 || !row.slice(divider + 1).trim()) throw new Error(msg("内容检查每行使用「文件名 | 需要出现的文字」。"));
        return { path: row.slice(0, divider).trim(), contains: row.slice(divider + 1).trim() };
      });
      setCheckError("");
      const values: Params = {
        id: task?.id, version: task?.version, projectId, title: val(data, "title"), instructions: val(data, "instructions"),
        initialStatus: task || immediate ? undefined : status,
        expectedFiles: lines(val(data, "files")), textChecks, reviewCriteria: val(data, "review"),
        inputVersionIds: data.getAll("inputAssets")
      };
      if (immediate) {
        values.timing = "now";
        values.sessionChoice = choice;
        const signature = JSON.stringify([values, draft.items.map(item => item.key)]);
        if (lastStart.current?.signature !== signature) lastStart.current = { signature, key: requestKey() };
        values.requestKey = lastStart.current.key;
      }
      await save({ ...values, ...await draft.stage(projectId) });
    } catch (error) {
      setCheckError((error as Error).message);
      const settings = checkInput.current?.closest("details");
      if (settings) settings.open = true;
      checkInput.current?.focus();
    } finally { submitting.current=false; setUploading(false); }
  };
  return <form className="task-form" data-dragging={draft.over} onSubmit={submit}
    onPaste={uploading || busy ? undefined : draft.paste} onDragOver={uploading || busy ? undefined : draft.dragOver} onDragLeave={draft.leave} onDrop={uploading || busy ? undefined : draft.drop}>
    <div className="task-form-fields">
      <label>
        <span>{msg("任务标题")} <span className="required-mark" aria-hidden="true">*</span></span>
        <input name="title" maxLength={160} defaultValue={task?.title} placeholder={msg("为任务起一个简短的标题")} required data-initial-focus />
      </label>
      <label>
        <span>{msg("任务说明")} <span className="required-mark" aria-hidden="true">*</span></span>
        <textarea name="instructions" maxLength={18000} rows={4} defaultValue={task?.instructions}
          placeholder={msg("说明要完成的工作和预期结果")} required />
      </label>
      <div className="task-attachments">
        <div className="row between wrap">
          <div className="row"><span>{msg("任务附件")}</span><AttachmentButtons draft={draft} disabled={busy || uploading}/></div>
          {!task && <label className="task-initial-status">{msg("初始状态")}
            <select name="status" value={status} disabled={busy || uploading} onChange={event => setStatus(event.target.value as typeof status)}>
              <option value="now">{msg("立即执行")}</option>
              {taskStatuses.map(value => <option value={value} key={value}>{msg(taskLabels[value])}</option>)}
            </select>
          </label>}
        </div>
        <AttachmentList draft={draft} disabled={busy || uploading}/>
      </div>
      {immediate && <SessionSelect projectId={projectId} value={choice} onChange={setChoice} disabled={busy || uploading}/>}
      <div className="task-form-options">
        <Disclosure title={msg("可选设置")} open={Boolean(task)}>
          <div className="task-form-settings">
            <div className="two">
              <label>{msg("必交文件")}<textarea name="files" rows={2} placeholder={msg("每行一个相对文件名")}
                defaultValue={task?.expectedFiles.join("\n")} /></label>
              <label>{msg("内容检查")}<textarea ref={checkInput} name="checks" rows={2} placeholder={msg("文件名 | 需要出现的文字")}
                aria-invalid={Boolean(checkError)} aria-describedby={checkError ? checkErrorId : undefined}
                onChange={() => { if (checkError) setCheckError(""); }}
                defaultValue={task?.textChecks.map(rule => `${rule.path} | ${rule.contains}`).join("\n")} /></label>
            </div>
            {checkError && <p id={checkErrorId} role="alert" className="inline-error">{checkError}</p>}
            <label>{msg("人工验收说明")}<textarea name="review" rows={2} maxLength={8000} defaultValue={task?.reviewCriteria} /></label>
            <fieldset>
              <legend>{msg("关联输入资产")}</legend>
              <div className="options">
                {available.map(({ version, name }) => <label key={version.id} className="check">
                  <input name="inputAssets" type="checkbox" value={version.id} aria-label={msg("关联 {0} v{1}", name, version.revision)}
                    defaultChecked={task?.inputVersionIds.includes(version.id)} />
                  <span>{name} <small>v{version.revision}</small></span>
                </label>)}
                {!available.length && <p className="muted">{msg("在项目资产页导入文件后可关联输入。")}</p>}
              </div>
            </fieldset>
          </div>
        </Disclosure>
      </div>
    </div>
    <div className="actions task-form-actions">
      <button type="button" disabled={busy} onClick={cancel}>{msg("取消")}</button>
      <button type="submit" className="primary" disabled={busy || uploading || draft.readingClipboard}>
        {immediate ? (busy || uploading ? msg("启动中…") : msg("创建并立即执行")) : (busy || uploading ? msg("保存中…") : msg("保存任务"))}
      </button>
    </div>
  </form>;
}

export function ImportForm({ save, busy }: { save: (paths: string[]) => void; busy: boolean }) {
  const [value, setValue] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const choose = async () => {
    setPicking(true);
    setError("");
    try { const paths = await pick("files"); if (paths.length) setValue(paths.join("\n")); }
    catch (error) { setError(String(error)); }
    finally { setPicking(false); }
  };
  return <form onSubmit={event => { event.preventDefault(); save(lines(value)); }}>
    <button type="button" className="native-picker" onClick={choose} disabled={picking}>
      <Icon name="projects" />{picking ? msg("等待选择文件") : msg("选择本机文件")}
    </button>
    <label>{msg("资产文件路径")}<textarea rows={4} value={value} onChange={event => setValue(event.target.value)}
      placeholder={msg("每行填写一个已选文件的绝对路径")} required data-initial-focus /></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions"><button className="primary" disabled={busy || picking}>{msg("确认导入")}</button></div>
  </form>;
}

export function AssetForm({ asset, groups, save, busy }: { asset: Asset; groups: string[]; save: Submit; busy: boolean }) {
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save({ id: asset.id, version: asset.version, name: val(data, "name"), groupName: val(data, "groupName"), context: data.has("context") });
  }}>
    <label>{msg("资产名称")}<input name="name" required maxLength={160} defaultValue={asset.name} data-initial-focus /></label>
    <GroupField label={msg("自定义分组")} name="groupName" value={asset.groupName} options={groups} />
    <label className="check"><input name="context" type="checkbox" defaultChecked={Boolean(asset.context)} /> {msg("作为项目上下文")}</label>
    <div className="actions"><button className="primary" disabled={busy}>{msg("保存资产")}</button></div>
  </form>;
}

export function ReviewForm({ task, run, files, save, busy, preview }: { files?:ConversationFile[]; task: Task; run?: Run; save: Submit; busy: boolean; preview?:(id:string)=>void }) {
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    save({ id: task.id, runId: run?.id, version: task.version, decision: button?.value || "accept", note: val(data, "note") });
  }}>
    <Acceptance task={task} run={run} files={files} preview={preview}/>
    <label>{msg("验收记录（选填）")}<textarea name="note" rows={3} maxLength={8000} data-initial-focus /></label>
    <div className="actions">
      <button className="primary" value="accept" disabled={busy}>{msg("确认通过")}</button>
      <button value="return" disabled={busy}>{msg("退回待办")}</button>
    </div>
  </form>;
}

export function RefineForm({ task, run, busy, canStart, save, cancel }: {
  task: Task; run?: Run; busy: boolean; canStart: boolean; save: (prepare: () => Promise<Params>) => void; cancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [choice,setChoice]=useState<SessionChoice>(automatic);
  const [key] = useState(requestKey);
  const inputId = useId();
  const draft = useTaskAttachments();
  const canSubmit = canStart && !busy && !draft.readingClipboard && Boolean(note.trim() || draft.items.length);
  return <form className="refine-form" data-dragging={draft.over}
    onPaste={busy ? undefined : draft.paste} onDragOver={busy ? undefined : draft.dragOver}
    onDragLeave={draft.leave} onDrop={busy ? undefined : draft.drop}
    onSubmit={event => {
      event.preventDefault();
      if (canSubmit) save(async () => ({
        id: task.id, runId: run?.id, version: task.version, requestKey: key, note, sessionChoice:choice,
        ...await draft.stage(task.projectId)
      }));
    }}>
    <div className="refine-input">
      <label htmlFor={inputId}>{msg("补充需求")}</label>
      <div className="refine-composer">
        <textarea id={inputId} value={note} onChange={event => setNote(event.target.value)} maxLength={8000}
          required={!draft.items.length} readOnly={busy} rows={4} data-initial-focus placeholder={msg("说明希望调整的内容，或添加参考附件…")} />
        <AttachmentList draft={draft} disabled={busy}/>
        <AttachmentButtons draft={draft} disabled={busy}/>
      </div>
    </div>
    <SessionSelect projectId={task.projectId} value={choice} onChange={setChoice} disabled={busy}/>
    <p className="muted">{canStart ? msg("新一轮执行会沿用任务要求和已有交付。补充附件随本轮执行保存。") : msg("当前项目暂时无法启动任务，请在项目可执行时提交。")}</p>
    <div className="actions">
      <button type="submit" className="primary" disabled={!canSubmit}>{busy ? msg("正在提交…") : msg("提交并继续优化")}</button>
      <button type="button" disabled={busy} onClick={cancel}>{msg("取消")}</button>
    </div>
  </form>;
}

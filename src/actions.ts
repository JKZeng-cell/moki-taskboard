import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Files, projectDirectory } from "./assets.ts";
import { AttachmentUploads } from "./attachments.ts";
import { deliveryPreview } from "./delivery-preview.ts";
import { completeSummary, summaryFile } from "./session-summary.ts";
import { saveRelease } from "./project-dashboard.ts";
import { activityRange } from "./calendar.ts";
import { retryConversationFiles } from "./conversation-files.ts";
import { semanticStatus } from "./semantic-capture.ts";
import { type CaptureService, localThreadId, sessionState } from "./capture.ts";
import { arrange } from "./panel-layout.ts";
import { policyFor, savePolicy, scheduleWindow } from "./schedule.ts";
import { beginEdit, readEdit, saveEdit, refreshSource } from "./asset-edits.ts";
import type { Params } from "./types.ts";
import { array, id, object } from "./validation.ts";
import type { Store } from "./store.ts";
import type { Runner } from "./runner.ts";
import type { Reader } from "./capture.ts";
import type { ModelOption } from "./types.ts";
import { version } from "./version.ts";
import { projectSessionOptions } from "./session-routing.ts";
import { pendingApprovals } from "./approval-reminders.ts";
import { codexPermissions } from "./execution-permissions.ts";
import type { PermissionOption } from "./types.ts";
import { sessionAddress } from "./host-identity.ts";

type Platform = {
  store: Store; files: Files; worker: Pick<Runner,"start"|"stop"|"reconcile"|"decide">;
  capture: CaptureService; models: () => Promise<ModelOption[]>; reader: () => Promise<Reader>;
  permissions?: () => PermissionOption[];
  launchThread: (url:string) => Promise<void>; version?: string;
};
const execute=promisify(execFile);
declare const __MOKI_PICKER_SCRIPT__: string;
let picking = false;
async function pick(kind: unknown, clipboardPath?: string) {
  if (process.platform !== "win32") throw new Error("请填写绝对路径。");
  if (kind !== "files" && kind !== "directory" && kind !== "clipboardFiles") throw new Error("请选择本地文件或目录。");
  if (picking) throw new Error("已有文件选择窗口打开。");
  picking = true;
  try {
    const script = typeof __MOKI_PICKER_SCRIPT__ === "string" ? __MOKI_PICKER_SCRIPT__ :
      await readFile(new URL("../scripts/pick-path.ps1", import.meta.url), "utf8");
    const command = Buffer.from("& {\n" + script + "\n} -Kind " + kind, "utf16le").toString("base64");
    const { stdout } = await execute("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", command
    ], { windowsHide: true, encoding: "utf8", timeout: 165000,
      ...(clipboardPath ? {env:{...process.env, MOKI_CLIPBOARD_IMAGE:clipboardPath}} : {}) });
    const paths: string[] = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    return {paths, ...(clipboardPath && paths.includes(clipboardPath) ? {imageName:"粘贴截图.png"} : {})};
  } catch (error) {
    if ((error as {killed?: boolean}).killed) throw new Error("选择窗口已超时，请再次打开。");
    throw new Error("Windows 未能打开选择窗口，请重试或直接填写本机路径。");
  } finally { picking = false; }
}

export function createActions({store,files,worker,capture,models,reader,launchThread,permissions=()=>codexPermissions,version:hostVersion=version}:Platform) {
  const uploads = new AttachmentUploads(files);
  async function policyRoots(values: Params, projectId: string) {
    const prior = policyFor(store, projectId);
    const paths = array(values.roots, "授权目录", 32);
    return [...new Set(await Promise.all(paths.map(path => !values.capture && typeof path === "string" && prior.roots.includes(path) ? path : projectDirectory(path))))];
  }
  function scanAfterSave(policy: ReturnType<typeof savePolicy>) {
    if (policy.capture && policy.semanticScope !== "off") void capture.scan().catch(() => {});
  }
  return async function dispatch(action: unknown, params: Params) {
    switch (action) {
      case "health": return { protocol: 1, version: hostVersion };
      case "state": {
        const board=store.state(params.projectId,params.projectsOnly===true,activityRange(params.activityWeeks));
        return {...board, window:board.policy?scheduleWindow(board.policy,Date.now()):null, scanError:board.policy?.capture?capture.lastError:"",
          semantics:board.project && board.policy?.capture && board.policy.semanticScope !== "off" ? semanticStatus(store,board.project.id) : undefined};
      }
      case "ui.arrange": return arrange(store,params);
      case "project.policy": {
        const roots = await policyRoots(params, store.project(params.id,true).id);
        const saved=savePolicy(store,params,roots);
        scanAfterSave(saved);
        return saved;
      }
      case "project.policyRead": return policyFor(store,store.project(params.id,true).id);
      case "project.worktrees": {
        const project=store.project(params.id,true);
        const result=await execute("git",["-C",project.root,"worktree","list","--porcelain","-z"],{windowsHide:true,timeout:8000,encoding:"utf8"});
        return result.stdout.split("\0").filter(line=>line.startsWith("worktree ")).map(line=>line.slice(9));
      }
      case "project.sessionOptions": return projectSessionOptions(store,store.project(params.projectId,true).id);
      case "thread.taskOptions": {
        const project = store.project(params.projectId, true);
        return store.all<{ id: string; title: string }>(
          "SELECT id,title FROM tasks WHERE projectId=? AND lifecycle='active' ORDER BY createdAt DESC,id", project.id);
      }
      case "thread.bind": return capture.bind(params);
      case "thread.scan": {
        const project=store.project(params.projectId,true);
        if(!policyFor(store,project.id).capture)throw new Error("请先启用项目会话归集。");
        await retryConversationFiles(store,project.id);
        await capture.scan();return {scanned:true};
      }
      case "thread.summary": return completeSummary(store, params, reader);
      case "thread.summaryFile": return summaryFile(store, params);
      case "thread.session":
      case "thread.openWindows": {
        const pid=store.project(params.projectId).id, tid=localThreadId(params.threadId);
        if(!store.get("SELECT 1 FROM runs WHERE projectId=? AND threadId=?",pid,tid) && !sessionState(store,pid).links.some(link=>link.threadId===tid))throw new Error("此会话不属于当前项目。");
        const url=sessionAddress(tid);
        if(action==="thread.openWindows")await launchThread(url);
        return {url};
      }
      case "approval.pending": return pendingApprovals(store);
      case "approval.decide": return worker.decide(id(params.id),id(params.runId),params.decision);
      case "asset.editBegin": return beginEdit(store,files,params);
      case "asset.editRead": return readEdit(store,files,params);
      case "asset.editSave": return saveEdit(store,files,params);
      case "asset.refreshSource": return refreshSource(store,files,params);
      case "ui.composer": return store.setComposerMinimized(params.minimized);
      case "ui.assetView": return store.setAssetView(params.view);
      case "ui.sidebar": return store.setSidebarCollapsed(params.collapsed);
      case "permissions.list": return permissions();
      case "models.list": return models();
      case "attachment.clipboardImage": return uploads.clipboardImage(params.token,params.thumbnail===true);
      case "pick": {
        const result=await pick(params.kind,params.kind==="clipboardFiles"?await uploads.clipboardTarget():undefined);
        return params.kind==="clipboardFiles"?{...result,images:uploads.rememberClipboardImages(result.paths)}:result;
      }
      case "project.release": return saveRelease(store, params);
      case "project.save": {
        if (params.permission !== undefined && !permissions().some(option => option.value === params.permission))
          throw new Error("宿主不支持所选项目权限，请刷新后重新选择。");
        const root = await projectDirectory(params.root);
        if (params.policy === undefined) return store.saveProject(params, root);
        const values = object(params.policy);
        const roots = await policyRoots(values, store.project(params.id,true).id);
        const saved = store.transaction(() => {
          const project = store.saveProject(params,root);
          const policy = savePolicy(store,{...values,id:project.id},roots);
          return {project,policy};
        });
        scanAfterSave(saved.policy);
        return saved.project;
      }
      case "project.lifecycle": return store.changeLifecycle("projects", params);
      case "task.lifecycle": return store.changeLifecycle("tasks", params);
      case "asset.lifecycle": return store.changeLifecycle("assets", params);
      case "attachment.begin": return uploads.begin(store.project(params.projectId,true).id, params);
      case "attachment.chunk": return uploads.chunk(store.project(params.projectId,true).id, params);
      case "task.save": {
        if (!params.uploads && !params.attachmentPaths) return store.saveTask(params);
        const project = store.project(params.id ? store.taskRow(params.id,true).projectId : params.projectId,true);
        return store.saveTask(params,await uploads.resolve(project.id, params));
      }
      case "task.quickCreate": {
        const copies = params.uploads || params.attachmentPaths ? await uploads.resolve(store.project(params.projectId).id, params) : [];
        const result = store.quickCreate(params, copies);
        if (result.created && result.runId) worker.start(result.runId);
        return result;
      }
      case "task.status": return store.changeTaskStatus(params);
      case "task.enqueue": return store.queue(params, "add");
      case "task.dequeue": return store.queue(params, "remove");
      case "task.reopen": return store.queue(params, "reopen");
      case "task.move": return store.queue(params, "move");
      case "asset.save": return store.saveAsset(params);
      case "asset.import": {
        const project = store.project(params.projectId, true);
        const selected = array(params.paths, "待导入文件", 32);
        if (!selected.length) return [];
        const copies = [];
        for (const path of selected) copies.push(await files.importFile(path));
        return store.importFiles(project.id, copies);
      }
      case "asset.deliveryPreview": {
        const project=store.project(params.projectId);
        return deliveryPreview(files,store.version(project.id,params.versionId),params.thumbnail===true);
      }
      case "asset.preview": {
        const project = store.project(params.projectId);
        return { path: await files.preview(store.version(project.id, params.versionId)) };
      }
      case "project.start":
      case "task.start": {
        const result = store.claim(params, action === "project.start");
        if (result.created) worker.start(result.id);
        return result;
      }
      case "run.stop": {
        const result = store.requestStop(params.runId);
        worker.stop(result.id);
        return result;
      }
      case "run.reconcile": {
        await worker.reconcile(store.run(params.runId).id);
        return { id: params.runId };
      }
      case "run.review":
      case "task.review": return store.review(params);
      case "task.refine": {
        const attachments = params.uploads || params.attachmentPaths
          ? await uploads.resolve(store.taskRow(params.id).projectId, params) : [];
        const result = store.refine(params, attachments);
        if (result.created) worker.start(result.id);
        return result;
      }
      case "run.session":
      case "run.openWindows": {
        const run = store.run(params.runId);
        const thread = localThreadId(run.threadId);
        const url = sessionAddress(thread);
        if (action === "run.openWindows") {
          await launchThread(url);
          store.event(run.id, "已发起 Windows 会话跳转");
        }
        return { url };
      }
      default: throw new Error("不支持此任务台操作。");
    }
  };
}

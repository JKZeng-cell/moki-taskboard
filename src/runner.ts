import { rm, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppServer, RpcError } from "./app-server.ts";
import { errorText, Files } from "./assets.ts";
import type { Delivery } from "./assets.ts";
import { dispatchRoute, saveRoute } from "./session-routing.ts";
import type { Route } from "./session-routing.ts";
import { classifyJson } from "./semantic.ts";
import { codexPermission } from "./execution-permissions.ts";
import { notifyApproval } from "./approval-reminders.ts";
import { deliveryInstructions, prepareReplyDelivery } from "./reply-delivery.ts";
import { chooseModel, listModels } from "./models.ts";
import type { Store } from "./store.ts";
import type { RunRecord } from "./types.ts";
import { relativeFile } from "./validation.ts";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { Params } from "./types.ts";

type Turn = { id: string; status: "inProgress" | "completed" | "failed" | "interrupted"; completedAt?:number|null; items?:{type:string;text?:string;clientId?:string;content?:{text?:string}[]}[]; durationMs?: number | null; error?: { message?: string } };
type Terminal = { turn: Turn } | { disconnected: Error };

const emptyDelivery = (): Delivery => ({ summary: "", checks: [], files: [] });
const workspacePolicy = (root: string) => ({
  type: "workspaceWrite", writableRoots: [root], networkAccess: false,
  excludeTmpdirEnvVar: true, excludeSlashTmp: true
});

async function verifyWorkspace(server: AppServer, root: string) {
  const check = ".moki-write-check";
  const command = process.platform === "win32"
    ? [join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoProfile", "-NonInteractive", "-Command",
      "Set-Content -NoNewline -LiteralPath '.moki-write-check' -Value 'taskboard' -Encoding Ascii"]
    : ["sh", "-c", "printf taskboard > .moki-write-check"];
  const path = join(root, check);
  try {
    const result = await server.call<{ exitCode: number; stderr?: string }>("command/exec", {
      command, cwd: root, timeoutMs: 15000, sandboxPolicy: workspacePolicy(root)
    }, 22000);
    if (result.exitCode !== 0 || (await readFile(path, "utf8")) !== "taskboard") {
      throw new Error(result.stderr?.trim() || "执行目录写入校验未通过。");
    }
  } catch (error) {
    throw new Error(`Codex 执行环境未能写入隔离目录：${errorText(error)}`);
  } finally {
    await unlink(path).catch(() => {});
  }
}

export async function prepare(run: RunRecord, files: Files) {
  const { snapshot, workDir } = run;
  await Promise.all([mkdir(join(workDir, "inputs"), { recursive: true }), mkdir(join(workDir, "outputs"), { recursive: true })]);
  const inputs = [];
  for (const [index, file] of snapshot.files.entries()) {
    const fileName = relativeFile(file.fileName);
    if (fileName.includes("/")) throw new Error("输入文件名无效。");
    const path = `inputs/${String(index + 1).padStart(2, "0")}-${fileName}`;
    await files.copyVersion(file, join(workDir, path));
    inputs.push({ path, name: file.name, revision: file.revision, sha256: file.sha256, role: file.role, refinementAttachment: file.refinementAttachment, previousPath: file.previousPath });
  }
  if (snapshot.conversationHandoff?.length) {
    await writeFile(join(workDir,"inputs","conversation-handoff.json"), JSON.stringify(snapshot.conversationHandoff,null,2), "utf8");
  }
  await writeFile(join(workDir, "inputs", "manifest.json"), JSON.stringify(inputs, null, 2), "utf8");
  return inputs;
}

export class Runner {
  private readonly sampled=new Map<string,string>();
  private readonly approvals=new Map<string,{runId:string;promise:Promise<{decision:string}>;resolve:(value:{decision:string})=>void}>();
  private readonly jobs = new Map<string, { interrupt?: () => void }>();
  protected readonly store: Store;
  protected readonly files: Files;

  constructor(store: Store, files: Files) {
    this.store = store;
    this.files = files;
  }

  start(runId: string) {
    if (this.jobs.has(runId)) return;
    const job: { interrupt?: () => void } = {};
    this.jobs.set(runId, job);
    void this.execute(runId, job).catch(error => this.store.recover(runId, errorText(error)))
      .finally(() => { this.sampled.delete(runId); this.jobs.delete(runId); });
  }

  stop(runId: string) {
    this.expireApprovals(runId);
    this.jobs.get(runId)?.interrupt?.();
  }

  private expireApprovals(runId:string){
    this.store.write("UPDATE run_approvals SET status='expired' WHERE runId=? AND status='pending'",runId);
    for(const [key,item] of this.approvals)if(item.runId===runId){item.resolve({decision:"decline"});this.approvals.delete(key);}
  }

  decide(id:string,runId:string,decision:unknown){
    if(decision!=="accept"&&decision!=="decline")throw new Error("审批结论无效。");
    const item=this.approvals.get(id),run=this.store.run(runId);
    if(!item||item.runId!==runId||run.status!=="running"||run.stopRequested||(run.deadline!==null&&Date.now()>=run.deadline))throw new Error("审批已失效。");
    this.store.write("UPDATE run_approvals SET status=? WHERE id=? AND status='pending'",decision,id);
    if(decision==="accept")this.store.write("UPDATE run_checkpoints SET safe=0 WHERE runId=?",runId);
    item.resolve({decision});this.approvals.delete(id);
    if(!this.store.get("SELECT 1 FROM run_approvals WHERE runId=? AND status='pending'",runId))this.store.progress(runId,"已处理审批，继续执行");
    this.store.event(runId,decision==="accept"?"用户允许本次操作":"用户拒绝本次操作");
  }

  async approval(runId:string,method:string,p:Params){
    if(method==="item/permissions/requestApproval") {
      const requested=p.permissions as Params|undefined;
      if(!requested || typeof requested!=="object" || Array.isArray(requested))return {permissions:{},scope:"turn"};
      const result=await this.requestDecision(runId,method,p);
      return {permissions:result.decision==="accept"?{...(requested.fileSystem?{fileSystem:requested.fileSystem}:{}),...(requested.network?{network:requested.network}:{})}:{},scope:"turn"};
    }
    if(method!=="item/commandExecution/requestApproval"&&method!=="item/fileChange/requestApproval")throw new Error("不支持此审批类型。");
    return this.requestDecision(runId,method,p);
  }

  private async requestDecision(runId:string,method:string,p:Params){
    const run=this.store.run(runId);
    if(run.status!=="running"||run.stopRequested||!run.threadId||!run.turnId||p.threadId!==run.threadId||p.turnId!==run.turnId||
      typeof p.itemId!=="string"||(run.deadline!==null&&Date.now()>=run.deadline))return {decision:"decline"};
    if(Array.isArray(p.availableDecisions)&&!p.availableDecisions.includes("accept"))return {decision:"decline"};
    const key=JSON.stringify([p.itemId,p.approvalId??null]);
    const detail=JSON.stringify({command:p.command,cwd:p.cwd,reason:p.reason,grantRoot:p.grantRoot,network:p.networkApprovalContext,permissions:p.permissions??p.additionalPermissions,itemId:p.itemId},null,2);
    const prior=this.store.get<{id:string;status:string;detail:string}>("SELECT id,status,detail FROM run_approvals WHERE runId=? AND threadId=? AND turnId=? AND itemKey=? AND kind=?",runId,run.threadId,run.turnId,key,method);
    if(prior){
      if(!isDeepStrictEqual(JSON.parse(prior.detail),JSON.parse(detail)))return {decision:"decline"};
      return this.approvals.get(prior.id)?.promise??{decision:prior.status==="accept"?"accept":"decline"};
    }
    const id=randomUUID(),wait=Promise.withResolvers<{decision:string}>();
    this.store.write("INSERT INTO run_approvals(id,runId,threadId,turnId,itemKey,kind,detail,createdAt) VALUES(?,?,?,?,?,?,?,?)",id,runId,run.threadId,run.turnId,key,method,detail,new Date().toISOString());
    this.approvals.set(id,{runId,...wait});this.store.progress(runId,"等待用户审批");
    notifyApproval(this.store,runId,id);
    return wait.promise;
  }

  isActive(runId: string) {
    return this.jobs.has(runId);
  }

  async finish(run: RunRecord, turn: Turn) {
    let stage:string|undefined;
    if(run.snapshot.permission==="read-only" && turn.status==="completed") {
      try { stage=await prepareReplyDelivery(this.store.root,this.files,run,turn); }
      catch(error) {
        this.store.finish(run.id,"completed",{summary:"",checks:[{label:"只读交付清单",passed:false,detail:errorText(error)}],files:[]},errorText(error),turn.durationMs,turn.completedAt?turn.completedAt*1000:undefined);
        return;
      }
    }
    try { await this.finishFiles(stage?{...run,workDir:stage}:run,turn); }
    finally {if(stage)await rm(stage,{recursive:true,force:true});}
  }

  private async finishFiles(run: RunRecord, turn: Turn) {
    this.store.progress(run.id, "核对回合及产物", undefined, turn.id);
    const current=this.store.run(run.id);
    const ended=typeof turn.completedAt==="number"?turn.completedAt*1000:Date.now();
    const deadline=current.deadline??Infinity;
    if(turn.status==="interrupted"||ended>=deadline)await this.sampleCheckpoint(current.id,Math.min(Date.now(),deadline-1));
    const delivery = turn.status === "completed" || turn.status === "interrupted"
      ? await this.files.collect(run.workDir,run.snapshot,false,ended>=deadline?deadline:Infinity)
      : emptyDelivery();
    this.store.finish(run.id, turn.status, delivery, turn.error?.message ?? "", turn.durationMs,
      typeof turn.completedAt==="number"?turn.completedAt*1000:undefined);
  }

  async sampleCheckpoint(runId:string,at=Date.now()){
    const run=this.store.run(runId);
    if(run.deadline===null||at>=run.deadline)return;
    const manifest=join(run.workDir,"outputs","checkpoint.json");
    const info=await stat(manifest).catch(()=>null);
    if(!info||!info.isFile()||info.mtimeMs>=run.deadline)return;
    const fingerprint=info.mtimeMs+"/"+info.size;
    if(this.sampled.get(runId)===fingerprint)return;
    const receipt=await this.files.collect(run.workDir,run.snapshot,true,Math.min(at+1,run.deadline));
    if(receipt.files.some(f=>f.role==="handoff")&&receipt.checks.every(c=>c.passed)){
      this.store.checkpoint(runId,receipt,at);this.sampled.set(runId,fingerprint);
    }
  }

  protected async execute(runId: string, job: { interrupt?: () => void }) {
    const run = this.store.run(runId);
    let server: AppServer | undefined;
    let launchRequested = false;
    let turnId: string | undefined;
    let threadId: string | undefined;
    let resumed=false;
    const receiptReady=Promise.withResolvers<void>();
    const earlyTurns=new Map<string,{turn:Turn;method:string}>();
    const earlyUsage = new Map<string, unknown[]>();
    let usageBase:Record<string,number>|undefined;
    const recordUsage=(value:unknown) => {
      if(!threadId||!turnId)return;
      if(!resumed) return this.store.recordUsage(runId,threadId,turnId,value);
      const usage=value as {total?:Record<string,number>;last?:Record<string,number>};
      const keys=["totalTokens","inputTokens","outputTokens"];
      if(!usage?.total || !usage.last || !keys.every(k=>Number.isSafeInteger(usage.total![k])&&Number.isSafeInteger(usage.last![k])))return;
      usageBase??=Object.fromEntries(keys.map(k=>[k,usage.total![k]-usage.last![k]]));
      this.store.recordUsage(runId,threadId,turnId,{total:Object.fromEntries(keys.map(k=>[k,usage.total![k]-usageBase![k]]))});
    };
    const flushUsage = () => {
      if (threadId && turnId && earlyUsage.has(turnId)) {
        for(const value of earlyUsage.get(turnId)!) recordUsage(value);
      }
      earlyUsage.clear();
    };
    let canInterrupt = false;
    let interruptInFlight = false;
    let interruptAccepted = false;
    let interruptRetry: NodeJS.Timeout | undefined;
    let attempts = 0;
    const terminal = Promise.withResolvers<Terminal>();
    try {
      this.store.progress(runId, "准备输入资产");
      const inputs = await prepare(run, this.files);
      if (this.store.run(runId).stopRequested) {
        this.store.finish(runId, "interrupted", emptyDelivery(), "用户在派发前取消。");
        return;
      }
      // The Windows workspace sandbox checks the full path, including expanded 8.3 directory names.
      const cwd = await realpath(run.workDir);
      server = await AppServer.open(cwd);
      server.onClose = disconnected => terminal.resolve({ disconnected });
      const rpc = server;
      rpc.onRequest=async(method,p)=>{
        if(launchRequested && !turnId && p.threadId===threadId)await receiptReady.promise;
        return this.approval(runId,method,p);
      };
      const interrupt = async () => {
        if (!threadId || !turnId || !canInterrupt || interruptInFlight || interruptAccepted ||
          !this.store.run(runId).stopRequested) return;
        interruptInFlight = true;
        try {
          await rpc.call("turn/interrupt", { threadId, turnId }, 10000);
          interruptAccepted = true;
        } catch (error) {
          if (++attempts <= 4 && /no active turn/i.test(errorText(error))) {
            interruptRetry = setTimeout(job.interrupt!, 420);
          } else {
            this.store.progress(runId, "等待 Codex 终态");
            this.store.event(runId, `中断请求：${errorText(error)}`);
          }
        } finally { interruptInFlight = false; }
      };
      job.interrupt = () => { void interrupt().catch(error => terminal.resolve({ disconnected: new Error(errorText(error)) })); };
      rpc.onNotification = ({ method, params }) => {
        if (!launchRequested || params.threadId !== threadId || !threadId) return;
        if (method === "turn/started" || method === "turn/completed") {
          const turn = params.turn as Turn | undefined;
          if (!turn?.id || (turnId && turnId !== turn.id)) return;
          if(resumed && !turnId){earlyTurns.set(turn.id,{turn,method});return;}
          turnId = turn.id;
          receiptReady.resolve();
          if (method === "turn/completed") {
            canInterrupt = false;
            terminal.resolve({ turn });
          } else {
            canInterrupt = true;
            this.store.progress(runId, "Codex 正在执行", threadId, turnId);
            flushUsage();
            job.interrupt?.();
          }
        } else if (method === "thread/tokenUsage/updated" && typeof params.turnId === "string") {
          if (!turnId) {
            const batch=earlyUsage.get(params.turnId)??[];
            batch.push(params.tokenUsage);earlyUsage.set(params.turnId,batch);
          } else if (params.turnId === turnId) recordUsage(params.tokenUsage);
        } else if (method === "item/started" && params.turnId === turnId) {
          const item = params.item as { type?: string } | undefined;
          if (item?.type === "commandExecution" && !this.store.run(runId).stopRequested) {
            this.store.progress(runId, "Codex 正在处理文件", threadId, turnId);
          }
        }
      };
      const runtime = await rpc.initialize();
      this.store.event(runId, `执行端：${runtime.userAgent || "Codex App Server"}`);
      this.store.progress(runId, "核对执行工作区");
      const permission=codexPermission(run.snapshot.permission,cwd);
      if(permission.sandbox==="workspace-write")await verifyWorkspace(rpc,cwd);
      if (this.store.run(runId).stopRequested) {
        this.store.finish(runId, "interrupted", emptyDelivery(), "用户在派发前取消。");
        return;
      }
      const { preferredModel, preferredEffort } = run.snapshot;
      const { model, effort } = chooseModel(await listModels(rpc), preferredModel, preferredEffort);
      this.store.write("UPDATE runs SET effectiveModel=?,effectiveEffort=? WHERE id=?", model, effort, runId);
      this.store.event(runId, `执行模型：${model} · ${effort || "模型默认"}`);
      this.store.progress(runId, "判断会话上下文");
      let route:Route=await dispatchRoute(this.store,run,req=>classifyJson(req,28000));
      if(route.threadId) {
        try {
          const read=await rpc.call<{thread:{id:string;status?:{type?:string};path?:string}}>("thread/read",{threadId:route.threadId,includeTurns:false},12000);
          const current=read.thread;
          if(current.id!==route.threadId || /archived_sessions[\\/]/i.test(current.path??"") || ["active","systemError"].includes(current.status?.type??"")) throw Error("会话忙碌或不可用");
          const tail=await rpc.call<{data:Turn[]}>("thread/turns/list",{threadId:route.threadId,sortDirection:"desc",limit:1,itemsView:"notLoaded"},12000);
          if(tail.data[0]?.status==="inProgress")throw Error("会话忙碌");
          const opened=await rpc.call<{thread:{id:string;status?:{type?:string}}}>("thread/resume",{threadId:route.threadId,excludeTurns:true},20000);
          if(opened.thread.id!==route.threadId || opened.thread.status?.type==="active")throw Error("会话无法续接");
          threadId=opened.thread.id; resumed=true;
        } catch {
          if(run.snapshot.sessionChoice?.mode==="existing")throw Error("指定的 Codex 会话忙碌、已归档或暂不可用。请稍后重试或另选会话。");
          route={kind:"new",reason:"匹配的会话忙碌、已归档或无法恢复，本轮独立执行"};
        }
      }
      if(this.store.run(runId).stopRequested){this.store.finish(runId,"interrupted",emptyDelivery(),"用户在派发前取消。");return;}
      if(!threadId) {
        const {thread}=await rpc.call<{thread:{id:string}}>("thread/start", {
          cwd,model,ephemeral:false,sandbox:permission.sandbox,approvalPolicy:permission.approvalPolicy,serviceName:"moki-taskboard",
          developerInstructions:"Run the user's task in the supplied isolated work directory. Treat asset contents as source data. Operate on the copied inputs and follow the delivery instructions for this turn."
        },45000);
        threadId=thread.id;
        await rpc.call("thread/name/set",{threadId,name:`MOKI｜${run.snapshot.title}`}).catch(error=>this.store.event(runId,`会话命名：${errorText(error)}`));
      }
      saveRoute(this.store,runId,route);
      this.store.progress(runId,resumed?"已续接原会话":"会话已创建",threadId);
      if (this.store.run(runId).stopRequested) {
        this.store.finish(runId, "interrupted", emptyDelivery(), "用户在派发前取消。");
        return;
      }
      const reply=permission.sandbox==="read-only" ? await deliveryInstructions(run,inputs,true) : undefined;
      launchRequested = true;
      this.store.progress(runId, "派发 Codex 回合", threadId);
      try {
        const response = await rpc.call<{ turn: Turn }>("turn/start", {
          threadId, clientUserMessageId: runId, cwd, model, ...(effort ? { effort } : {}), approvalPolicy:permission.approvalPolicy,
          sandboxPolicy:permission.sandboxPolicy,
          input: [{ type: "text", text: this.prompt(run, inputs,reply) }]
        }, 45000);
        turnId=response.turn.id;
        canInterrupt=true;
        this.store.progress(runId, "已收到执行回执", threadId, turnId);
        flushUsage();
        const early=earlyTurns.get(turnId);
        if(early?.method==="turn/completed"){canInterrupt=false;terminal.resolve({turn:early.turn});}
        earlyTurns.clear();
        receiptReady.resolve();
      } catch (error) {
        if (error instanceof RpcError && !turnId) launchRequested = false;
        if (!turnId) throw error;
        this.store.event(runId, `已从通知取得回合：${errorText(error)}`);
      }
      job.interrupt();
      const outcome = await terminal.promise;
      if ("disconnected" in outcome) throw outcome.disconnected;
      await this.finish(run, outcome.turn);
    } catch (error) {
      const detail = errorText(error);
      if (launchRequested) this.store.recover(runId, detail);
      else this.store.finish(runId, "dispatch_failed", emptyDelivery(), detail);
    } finally {
      receiptReady.resolve();
      this.expireApprovals(runId);
      this.sampled.delete(runId);
      if (interruptRetry) clearTimeout(interruptRetry);
      server?.close();
    }
  }

  protected prompt(run: RunRecord, inputs: { path: string; name: string; revision: number; role: string; refinementAttachment?: boolean }[], replyDelivery?: string) {
    const { snapshot } = run;
    return [
      `MOKI Taskboard run ${run.id}`,
      `本轮独立工作目录：${run.workDir}。本轮 inputs 和 outputs 中的相对路径均以此目录为基准。`,
      `项目：${snapshot.projectTitle}`,
      snapshot.projectDescription,
      `任务：${snapshot.title}`,
      snapshot.instructions,
      ...(run.deadline?["本次执行截止 "+new Date(run.deadline).toISOString()+"。阶段产物就绪时，写 outputs/checkpoint.json，格式同交付清单，附 handoff 文件。只有所有已执行操作均可安全重放或已在交接中记录并可跳过时才写 resumeSafe:true，否则为 false。"]:[]),
      ...(snapshot.checkpoint?["从上次中断的检查点继续。读取 inputs/manifest.json 中 previousPath 对应的部分产物和交接。",snapshot.checkpoint.summary]:[]),
      ...(snapshot.refinement ? [
        "按以下补充需求继续完善同一项任务。inputs/manifest.json 中的 previousPath 标识上一轮产物及其原交付路径。",
        ...snapshot.refinement.requirements.map((note, index) => `第 ${index + 1} 次补充需求\n${note}`),
        ...(snapshot.refinement.previousSummary ? [`上一轮交付摘要\n${snapshot.refinement.previousSummary}`] : [])
      ] : []),
      ...(snapshot.conversationHandoff?.length ? ["inputs/conversation-handoff.json 保存本次领取时的会话交接。结合任务范围阅读，其中含摘要、发言人和可追溯原话。与旧交接文件有出入时，核对来源和时间，按最新明确更正继续。"] : []),
      replyDelivery ? "使用下方固定的输入清单和所附资料完成任务。" : "运行时已固定输入版本。先读取 inputs/manifest.json 及任务需要的这些文件。",
      ...inputs.map(file => `- ${file.path} (${file.role}${file.refinementAttachment ? " · 本轮补充附件" : ""}, ${file.name}, v${file.revision})`),
      `必交文件（相对于 outputs）：${JSON.stringify(snapshot.expectedFiles)}`,
      `内容核验：${JSON.stringify(snapshot.textChecks)}`,
      `人工验收：${snapshot.reviewCriteria}`,
      ...(replyDelivery ? [replyDelivery] : ["把实际产物写入 outputs。需要交接时另写 Markdown，登记用途为 handoff。最后用 UTF-8 写 outputs/delivery.json。"]),
      "涉及界面、排版、图像等可视变化时，把实际运行界面或最终成品的截图、可预览样张一并写入 outputs 并登记为 output。无法取得实拍效果时，在交付摘要说明原因。",
      ...(replyDelivery ? [] : ['交付清单格式 {"summary":"概括已完成的工作","artifacts":[{"path":"实际文件名","role":"output"},{"path":"交接文件.md","role":"handoff"}]}。',
      "填写实际存在的文件名及用途。所有 path 相对于 outputs。交付清单本身由任务台读取。"])
    ].join("\n\n");
  }

  async reconcile(runId: string) {
    if (this.isActive(runId)) throw new Error("运行正在接收 Codex 回执。");
    const run = this.store.run(runId);
    if (!["recover", "running"].includes(run.status)) return;
    this.jobs.set(runId, {});
    let server: AppServer | undefined;
    try {
      if (["已领取","准备输入资产","核对执行工作区","判断会话上下文","建立 Codex 会话","已续接原会话","会话已创建"].includes(run.phase) && !run.turnId) {
        this.store.finish(runId, "dispatch_failed", emptyDelivery(), "后台服务在提交回合前退出，任务可以重新启动。");
        return;
      }
      if (!run.threadId) throw new Error("派发结果不明，需检查已登记会话和运行目录。");
      server = await AppServer.open(await realpath(run.workDir));
      await server.initialize();
      let turns: Turn[]=[];
      const matches=(t:Turn)=>run.turnId?t.id===run.turnId:t.items?.some(i=>i.type==="userMessage"&&(i.clientId===run.id||i.content?.some(v=>v.text?.startsWith("MOKI Taskboard run "+run.id+"\n"))));
      try {
        let cursor:string|null=null;
        do{
          const page:{data:Turn[];nextCursor:string|null}=await server.call("thread/turns/list",{
            threadId:run.threadId,sortDirection:"desc",limit:30,itemsView:run.turnId?"notLoaded":"full",cursor});
          turns=page.data;cursor=page.nextCursor;
        }while(cursor&&!turns.some(matches));
      } catch (error) {
        if (!(error instanceof RpcError) || ![-32600, -32601].includes(error.code)) throw error;
        const { thread } = await server.call<{ thread: { turns: Turn[] } }>("thread/read", {
          threadId: run.threadId, includeTurns: true
        });
        turns = thread.turns;
      }
      const turn = turns.find(matches);
      if(turn&&!run.turnId)this.store.progress(runId,"已找回派发回执",run.threadId,turn.id);
      if(turn?.status==="inProgress"&&run.stopRequested)await server.call("turn/interrupt",{threadId:run.threadId,turnId:turn.id},10000);
      if (!turn || turn.status === "inProgress") throw new Error("暂时无法确认旧回合已停止，保留执行占用。");
      if (turn.status === "interrupted" && !(run.stopRequested&&turn.completedAt&&turn.completedAt*1000>=(run.stopAt??Date.parse(run.startedAt))-1000)) {
        throw new Error("独立历史读取可能将未加载的回合显示为中断。缺少实时中断回执，保留执行占用。");
      }
      await this.finish(run, turn);
    } catch (error) {
      this.store.recover(runId, errorText(error));
    } finally {
      server?.close();
      this.jobs.delete(runId);
    }
  }
}

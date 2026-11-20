import { access, realpath, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Runner, prepare } from "../../src/runner.ts";
import { randomUUID } from "node:crypto";
import { dispatchRoute, saveRoute } from "../../src/session-routing.ts";
import { notifyApproval } from "../../src/approval-reminders.ts";
import { chooseModel } from "../../src/models.ts";
import { join } from "node:path";
import { deliveryInstructions, prepareReplyDelivery } from "./delivery.mjs";
import { classifyJson, modelOptions, readSession, sessionTurns } from "./sessions.mjs";

const empty=()=>({summary:"",checks:[],files:[]});
export class DshRunner extends Runner {
  reconciling = new Set();
  constructor(store,files,ctx,lifetime) {
    super(store,files);
    this.ctx=ctx;
    this.lifetime=lifetime;
  }
  isActive(id) { return super.isActive(id) || this.reconciling.has(id); }
  async execute(id,job) {
    const run=this.store.run(id);
    let submitted=false;
    try {
      this.store.progress(id,"准备输入资产");
      const inputs=await prepare(run,this.files);
      const cwd=await realpath(run.workDir);
      const models=await modelOptions(this.ctx);
      if (!models.length) throw Error("DSH 中没有可用模型。");
      const chosen=chooseModel(models,run.snapshot.preferredModel,run.snapshot.preferredEffort);
      const split=chosen.model.indexOf("/");
      const selection={provider:chosen.model.slice(0,split),model:chosen.model.slice(split+1),
        ...(chosen.effort ? {reasoningEffort:chosen.effort} : {})};
      this.store.progress(id,"判断会话上下文");
      let route=await dispatchRoute(this.store,run,request=>classifyJson(this.ctx,request,this.lifetime,28000));
      const presets=this.ctx.permissionPresets, catalog=presets.catalog();
      const setting=run.snapshot.permission??"default";
      const preset=setting==="default"?catalog.defaultPreset:setting.startsWith("dsh:")?setting.slice(4):undefined;
      if(!preset || !catalog.options.some(o=>o.value===preset))throw Error("DSH 的项目权限预设已不可用，请编辑项目重新选择。");
      let threadId="session-"+id,agent;
      if(route.threadId) {
        try {
          const observed=await readSession(this.ctx,route.threadId);
          if(observed.session.parentSession || sessionTurns(observed.events).at(-1)?.status==="inProgress")throw Error("busy");
          const resolved=await this.ctx.sessionController.resolveAgent(route.threadId);
          if(!resolved.agent)throw Error("unavailable");
          const candidate=resolved.agent;
          if(sessionTurns(candidate.session.log).at(-1)?.status==="inProgress")throw Error("busy");
          const owned=!!this.store.get("SELECT 1 FROM runs WHERE projectId=? AND 'session-'||id=? AND threadId=?",run.projectId,route.threadId,route.threadId);
          if(!owned && presets.current(candidate.session)!==preset)throw Error("permissions");
          if(owned)await this.ctx.workingDirectory.set(candidate,cwd,this.lifetime);
          agent=candidate;threadId=route.threadId;
        } catch {
          if(run.snapshot.sessionChoice?.mode==="existing")throw Error("指定的 DSH 会话忙碌、不可用或权限与项目设置不一致。请稍后重试或另选会话。");
          route={kind:"new",reason:"匹配的 DSH 会话忙碌、不可用或使用其他权限，本轮独立执行"};
        }
      }
      this.lifetime.throwIfAborted();
      if (this.store.run(id).stopRequested) return this.store.finish(id,"interrupted",empty());
      if(!agent) {
        const created=await this.ctx.sessionController.create({sessionId:threadId,cwd});
        if(created.sessionId!==threadId)throw Error("DSH 未返回本次任务的会话。");
        agent=this.ctx.agents.get(threadId);
        await this.ctx.sessionController.rename({sessionId:threadId,title:"MOKI｜"+run.snapshot.title});
      }
      saveRoute(this.store,id,route);
      this.store.progress(id,route.kind==="resume"?"已续接原会话":"会话已创建",threadId);
      if(sessionTurns(agent.session.log).at(-1)?.status==="inProgress")throw Error("所选会话刚刚开始了另一回合，可稍后重新启动。");
      if(presets.current(agent.session)!==preset)presets.set(agent.session,preset);
      await this.ctx.llm.resolveCallConfig(selection);
      agent.model.select(selection);
      this.store.write("UPDATE runs SET effectiveModel=?,effectiveEffort=? WHERE id=?",chosen.model,chosen.effort,id);
      this.store.progress(id,"派发 DSH 回合",threadId);
      this.lifetime.throwIfAborted();
      if (this.store.run(id).stopRequested) return this.store.finish(id,"interrupted",empty());
      const content=this.prompt(run,inputs,await deliveryInstructions(run,inputs,presets.resolve(preset).sandbox==="read-only"));
      if(this.store.run(id).stopRequested)return this.store.finish(id,"interrupted",empty());
      if(sessionTurns(agent.session.log).at(-1)?.status==="inProgress")throw Error("会话已有其他回合，任务尚未派发。");
      submitted=true;
      await this.ctx.sessionController.prompt({sessionId:threadId,requestId:id,mode:"followup",
        content:[{type:"text",text:content}]},this.lifetime);
      this.store.progress(id,"DSH 正在执行",threadId);
      let seen=0;
      while (!this.lifetime.aborted) {
        const session=this.ctx.sessions.get(threadId);
        if (!session) throw Error("DSH 会话已卸载，等待核对回执。");
        if (session.log.length!==seen) {
          seen=session.log.length;
          const turn=sessionTurns(session.log).find(t=>t.requests.includes(id));
          if (turn) {
            if (this.store.run(id).turnId!==turn.id) this.store.progress(id,"DSH 正在执行",threadId,turn.id);
            this.syncApprovals(id,threadId,turn);
            if (turn.status!=="inProgress") return await this.complete(run,threadId,turn);
            if (this.store.run(id).stopRequested) this.ctx.sessionController.cancel({sessionId:threadId});
          }
        }
        job.interrupt=()=>{
          const current=sessionTurns(this.ctx.sessions.get(threadId)?.log??[]).at(-1);
          if(current?.status==="inProgress"&&current.requests.includes(id))this.ctx.sessionController.cancel({sessionId:threadId});
        };
        await delay(400,undefined,{signal:this.lifetime});
      }
      throw Error("DSH 正在关闭。");
    } catch (e) {
      if (submitted) this.store.recover(id,e.message);
      else this.store.finish(id,"dispatch_failed",empty(),e.message);
    }
  }
  syncApprovals(runId,threadId,turn) {
    for(const a of turn.approvals) {
      const status=a.status==="pending" && turn.status!=="inProgress"?"expired":a.status;
      const row=this.store.get("SELECT id,status FROM run_approvals WHERE runId=? AND threadId=? AND turnId=? AND itemKey=? AND kind='dsh/approval'",runId,threadId,turn.id,a.id);
      if(row) {
        if(status!=="pending" && row.status!==status)this.store.write("UPDATE run_approvals SET status=? WHERE id=?",status,row.id);
        continue;
      }
      const key=randomUUID();
      this.store.write("INSERT INTO run_approvals(id,runId,threadId,turnId,itemKey,kind,detail,status,createdAt) VALUES(?,?,?,?,?,'dsh/approval',?,?,?)",
        key,runId,threadId,turn.id,a.id,JSON.stringify({tool:a.tool,reason:a.reason},null,2),status,new Date(a.at).toISOString());
      const run=this.store.run(runId);
      if(status==="pending" && !run.stopRequested && (run.deadline===null||Date.now()<run.deadline)){
        this.store.progress(runId,"等待 DSH 会话审批");notifyApproval(this.store,runId,key);
      }
    }
    if(turn.approvals.length && turn.status==="inProgress" && turn.approvals.every(a=>a.status!=="pending") &&
        this.store.run(runId).phase==="等待 DSH 会话审批")this.store.progress(runId,"已处理审批，DSH 正在执行");
  }
  async complete(run,threadId,turn) {
    this.store.progress(run.id,"核对 DSH 回执",threadId,turn.id);
    if (turn.usage) this.store.recordUsage(run.id,threadId,turn.id,{total:turn.usage});
    let stage;
    try {
      if (turn.status==="completed" && !await access(join(run.workDir,"outputs","delivery.json")).then(()=>true,e=>{
        if(e.code==="ENOENT") return false; throw e;
      })) {
        try { stage=await prepareReplyDelivery(this.store.root,this.files,run,turn); }
        catch(e) {
          this.store.finish(run.id,"completed",{summary:"",checks:[{label:"DSH 交付清单",passed:false,detail:e.message}],files:[]},e.message,turn.durationMs,turn.completedAt*1000);
          return;
        }
      }
      await this.finish(stage ? {...run,workDir:stage} : run,turn);
    } finally { if(stage) await rm(stage,{recursive:true,force:true}); }
  }
  async reconcile(id) {
    if (this.isActive(id)) return;
    const run=this.store.run(id);
    if (!["running","recover"].includes(run.status)) return;
    this.reconciling.add(id);
    try {
      if (!run.threadId || ["已领取","准备输入资产","判断会话上下文","会话已创建","已续接原会话"].includes(run.phase))
        return this.store.finish(id,"dispatch_failed",empty(),"DSH 在提交任务前已停止，可重新启动。");
      const observed=await readSession(this.ctx,run.threadId);
      const turn=sessionTurns(observed.events).find(t=>t.requests.includes(id));
      if(turn){
        if(!run.turnId)this.store.progress(id,"已找回 DSH 回执",run.threadId,turn.id);
        this.syncApprovals(id,run.threadId,turn);
      }
      if (turn && turn.status!=="inProgress") return await this.complete(run,run.threadId,turn);
      if (turn && run.stopRequested && this.ctx.agents.get(run.threadId)) this.ctx.sessionController.cancel({sessionId:run.threadId});
      this.store.recover(id,"等待 DSH 原会话的终态回执。");
    } finally { this.reconciling.delete(id); }
  }
}


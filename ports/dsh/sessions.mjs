import { randomUUID } from "node:crypto";
import { classificationRequest, validateAssessment } from "../../src/semantic.ts";
import { RpcError } from "../../src/app-server.ts";

export async function modelOptions(ctx) {
  const catalog = await ctx.sessionController.modelCatalog();
  return catalog.groups.flatMap(group => group.models.map(model => ({
    id: group.id + "/" + model.id, label: model.name + " · " + group.name,
    isDefault: group.id === catalog.default.provider && model.id === catalog.default.model,
    efforts: model.reasoning?.efforts.map(level => level.id) ?? [],
    defaultEffort: model.reasoning?.defaultEffort ?? null
  })));
}

export function sessionTurns(events) {
  const turns = [];
  let turn;
  for (const event of events) {
    const { type, data, time, seq } = event;
    if (type === "turn/start") {
      turn = { id: String(data.turn), status: "inProgress", startedAt: time / 1000, items: [], requests: [], approvals: [] };
      turns.push(turn);
    }
    if (!turn) continue;
    if (type === "user/message" && data.source?.kind === "user") {
      const content = data.content.flatMap(part => part.type === "text" ? [{ type: "text", text: part.text }] :
        part.path && typeof part.path === "string" ? [{type:"localImage",path:part.path}] : []);
      turn.items.push({ id: data.id ?? String(seq), type: "userMessage", content });
      if (data.source.rpcId) turn.requests.push(data.source.rpcId);
    }
    if (type === "assistant/message") {
      const text = data.message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (text) turn.items.push({ id: data.message.id ?? String(seq), type: "agentMessage", text });
      const u=data.usage;
      if (Number.isSafeInteger(u?.inputTokens) && Number.isSafeInteger(u?.outputTokens)) {
        turn.usage ??= { inputTokens:0, outputTokens:0, totalTokens:0 };
        turn.usage.inputTokens += u.inputTokens;
        turn.usage.outputTokens += u.outputTokens;
        turn.usage.totalTokens += u.totalTokens ?? u.inputTokens + u.outputTokens;
      }
    }
    if (type==="approval/asked" && typeof data.id==="string")
      turn.approvals.push({id:data.id,tool:data.toolName,reason:data.reason,at:time,status:"pending"});
    if (type==="approval/decided") {
      const asked=turn.approvals.find(a=>a.id===data.id);
      if(asked)asked.status=data.outcome==="allowed-once"?"accept":"decline";
    }
    if (type === "turn/end") {
      const kind = data.reason.kind;
      turn.status = kind === "completed" ? "completed" : ["aborted","interrupted"].includes(kind) ? "interrupted" : "failed";
      turn.completedAt = time / 1000;
      turn.durationMs = Math.max(0,time - turn.startedAt*1000);
      if (turn.status === "failed") turn.error = {message:data.reason.error?.message ?? kind};
      turn = undefined;
    }
  }
  return turns;
}

export async function readSession(ctx, id) {
  const live = ctx.sessions.get(id);
  if (live) return {session:live.header,events:live.log};
  try { return await ctx.sessionQuery.readSession(id); }
  catch (e) {
    if (/not.found|missing|不存在/i.test(String(e.code)+" "+e.message)) throw new RpcError("找不到 DSH 会话。",-32001);
    throw e;
  }
}

const page=(items,p) => {
  const start=Number(p.cursor ?? 0), end=start+Math.max(1,Math.min(100,p.limit ?? 30));
  return {data:items.slice(start,end),nextCursor:end<items.length ? String(end) : null};
};

export function sessionReader(ctx) {
  return {
    initialize: async () => ({userAgent:"DeepSeek Harness"}),
    close() {},
    async call(method,p) {
      if (method==="thread/list") {
        const {items}=await ctx.sessionController.list({},AbortSignal.timeout(60000));
        const rows=items.filter(item=>item.cwd && item.origin!=="subagent" && !item.blank &&
          (!p.cwd || p.cwd.some(path=>item.cwd.toLowerCase()===path.toLowerCase()))).map(item=>({
            id:item.sessionId,cwd:item.cwd,forkedFromId:item.parentSessionId,
            name:item.projections?.values?.title?.title ?? "",
            updatedAt:Math.floor(Math.max(item.updatedAt,ctx.sessions.get(item.sessionId)?.log.at(-1)?.time??0)/1000)
          }));
        return page(rows.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)),p);
      }
      const observed=await readSession(ctx,p.threadId);
      if (method==="thread/read") {
        const header=observed.session;
        const title=[...observed.events].reverse().find(e=>e.type==="session/title");
        return {thread:{id:header.id,cwd:header.cwd??"",forkedFromId:header.parentSession,
          name:title?.data.title??"",updatedAt:Math.floor((observed.events.at(-1)?.time??header.createdAt)/1000),
          ...(p.includeTurns ? {turns:sessionTurns(observed.events)} : {})}};
      }
      if (method==="thread/turns/list") return page(sessionTurns(observed.events).reverse(),p);
      throw Error("不支持的 DSH 会话读取操作。");
    }
  };
}

export async function classify(ctx, input, lifetime) {
  return validateAssessment(await classifyJson(ctx,classificationRequest(input),lifetime),input);
}

export async function classifyJson(ctx,request,lifetime,timeoutMs=150000) {
  const signal=AbortSignal.any([lifetime,AbortSignal.timeout(timeoutMs)]);
  const route=ctx.agentDefaultModel.currentSelection();
  const call=await ctx.llm.prepareCall(route,signal);
  const messages=[{role:"user",id:randomUUID(),source:{kind:"moki-taskboard"},content:[{type:"text",text:request.prompt}]}];
  const blocks=new Map();
  let finish;
  for await (const chunk of call.stream({...call.config, messages, signal, purpose:"moki-taskboard-classification",
    system:"你是文本分类器。仅返回符合此 JSON Schema 的 JSON 对象。\n"+JSON.stringify(request.schema)})) {
    if (chunk.type==="text-delta") blocks.set(chunk.index,(blocks.get(chunk.index)??"")+chunk.text);
    if (chunk.type==="block-end" && chunk.block.type==="text") blocks.set(chunk.index,chunk.block.text);
    if (chunk.type==="finish") finish=chunk.reason;
  }
  if (finish?.kind!=="stop") throw Error(finish?.failure?.message??"DSH 分类响应未完成。");
  const reply=[...blocks.values()].join("").trim().replace(/^```(?:json)?\s*|\s*```$/gi,"");
  return JSON.parse(reply);
}


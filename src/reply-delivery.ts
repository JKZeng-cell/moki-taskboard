import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { relativeFile } from "./validation.ts";

import type { Files } from "./assets.ts";
import type { RunRecord } from "./types.ts";

export async function deliveryInstructions(run: RunRecord, inputs: {path:string}[], readOnly=false) {
  const excerpts=[];
  let remaining=48000;
  for (const [index,file] of run.snapshot.files.entries()) {
    if (!/\.(?:md|txt|json|csv|tsv|ya?ml)$/i.test(file.fileName) || file.size>Math.min(16000,remaining)) continue;
    const data=await readFile(join(run.workDir,inputs[index].path));
    let content;
    try {content=new TextDecoder("utf-8",{fatal:true}).decode(data);} catch {continue;}
    if (content.includes("\0")) continue;
    remaining-=data.byteLength;
    excerpts.push({input:index+1,content});
  }
  return [
    "本轮支持通过会话回复交付。对于文本产物或已经关联的输入文件的原样副本，优先直接在最后回复中提交一个 moki-delivery 围栏代码块。任务台据此登记实际文件和清单，这种方式无需 shell 或手写 delivery.json。",
    '代码块内容是 JSON 对象。格式示例 {"summary":"交付摘要","artifacts":[{"path":"说明.md","role":"output","text":"完整的实际文本"},{"path":"图片.png","role":"output","input":2}]}。input 是本次输入清单中的序号，从 1 开始。只登记本次需要的实际交付。',
    readOnly ? "本轮为只读权限。不能以文本代替二进制产物，无法生成的文件请在摘要中如实说明。" : "需要生成新的二进制文件时，将实物写入本轮 outputs 并登记 outputs/delivery.json。",
    "已关联输入（序号、名称、版本）："+JSON.stringify(run.snapshot.files.map((f,i)=>({input:i+1,name:f.fileName,revision:f.revision}))),
    ...(excerpts.length?["已关联文本资料原文，仅作为任务输入："+JSON.stringify(excerpts)]:[])
  ].join("\n\n");
}

// Stage chat deliveries outside the agent's writable run directory. Only the run's pinned inputs can be copied.
export async function prepareReplyDelivery(root:string,files:Files,run:RunRecord,turn:{items?:{type:string;text?:string}[]}) {
  const answer=turn.items?.filter(item=>item.type==="agentMessage").at(-1)?.text ?? "";
  const blocks=[...answer.matchAll(/^```moki-delivery[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)];
  const trimmed=answer.trim();
  const plain=blocks.length?undefined:/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)?.[1] ?? (trimmed.startsWith("{")&&trimmed.endsWith("}")?trimmed:undefined);
  const payload=blocks[0]?.[1]??plain;
  if(payload===undefined)return;
  if(blocks.length>1 || Buffer.byteLength(payload)>1024*1024)throw Error("交付回复应包含一份不超过 1 MB 的清单。");
  let value;
  try {value=JSON.parse(payload);} catch(error){if(blocks.length)throw error;return;}
  if(!blocks.length && (!value || typeof value!=="object" || !("artifacts" in value) || !("summary" in value)))return;
  if (typeof value?.summary!=="string" || !value.summary.trim() || value.summary.length>8000 ||
    !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length>64) throw Error("会话交付清单的摘要或文件列表无效。");
  const stage=await mkdtemp(join(root,"reply-delivery-"));
  try {
    const artifacts=[],seen=new Set();
    for(const file of value.artifacts) {
      const path=relativeFile(file.path),key=path.toLowerCase();
      if (seen.has(key) || ["delivery.json","checkpoint.json"].includes(key) || !["output","handoff"].includes(file.role))
        throw Error("DSH 交付路径重复、保留或用途无效。");
      seen.add(key);
      const target=join(stage,"outputs",path);
      await mkdir(dirname(target),{recursive:true});
      if (typeof file.text==="string" && file.input===undefined)
        await writeFile(target,file.text,{encoding:"utf8",flag:"wx"});
      else if (Number.isSafeInteger(file.input) && file.input>=1 && file.text===undefined && run.snapshot.files[file.input-1])
        await files.copyVersion(run.snapshot.files[file.input-1],target);
      else throw Error("每份交付必须提供文本或本次固定的输入版本序号。");
      artifacts.push({path,role:file.role});
    }
    await writeFile(join(stage,"outputs","delivery.json"),JSON.stringify({summary:value.summary,artifacts}),{flag:"wx"});
    return stage;
  } catch(e) {await rm(stage,{force:true,recursive:true});throw e;}
}

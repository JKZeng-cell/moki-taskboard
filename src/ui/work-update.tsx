import { msg } from "./i18n.ts";
import type { ConversationUpdate } from "../types.ts";
import { Icon, timestamp } from "./common.tsx";

export function WorkUpdate({item,jump,openTask}: {item:ConversationUpdate; jump:(id:string)=>void; openTask?:(id:string)=>void}) {
  const author=item.author==="assistant"?msg("助手"):msg("用户");
  return <details className="work-update">
    <summary><Icon name={item.kind==="handoff"?"pin":"chat"} size={15}/><span>{item.summary}</span><small>{msg("{0}会话", author)}</small><Icon name="down" size={13}/></summary>
    <div><small>{msg("{0}记录", author)} · {timestamp(item.occurredAt)}</small><blockquote className="session-evidence">{item.quote}</blockquote>
      <div className="row"><button className="text-button" onClick={()=>jump(item.threadId)}>{msg("打开来源会话")}<Icon name="external" size={12}/></button>
        {item.taskId && openTask && <button className="text-button" onClick={()=>openTask(item.taskId!)}>{msg("查看任务")}</button>}</div>
    </div>
  </details>;
}

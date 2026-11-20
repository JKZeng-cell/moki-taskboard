import { msg } from "./i18n.ts";
import type { Source } from "../capture.ts";
import { Status } from "./common.tsx";

export function CaptureEvidence({source,jump}:{source:Source;jump:(id:string)=>void}) {
  const state=source.recognizedState;
  return <>
    {source.evidence && source.evidence !== state?.quote && <blockquote className="session-evidence">{source.evidence}</blockquote>}
    {state && <div className="capture-state">
      <div className="row"><span>{msg("会话识别")}</span><Status status={state.status} />
        <small title={state.turnId}>{state.author==="user" ? msg("用户") : msg("助手")} {msg("· 回合")} {state.turnId.slice(0,8)}</small></div>
      <blockquote className="session-evidence">{state.quote}</blockquote>
      {state.threadId && state.threadId !== source.threadId && <button className="text-button" onClick={() => jump(state.threadId!)}>{msg("打开状态来源会话")}</button>}
    </div>}
  </>;
}

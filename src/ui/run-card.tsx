import { msg, systemText } from "./i18n.ts";
import { permissionLabel } from "../execution-permissions.ts";
import { hostName } from "../host-identity.ts";
import type { ReactNode } from "react";
import { FileIcon } from "./file-icon.tsx";
import type { Run } from "../types.ts";
import { Usage } from "./usage.tsx";
import { effortLabel, Icon, timestamp } from "./common.tsx";

export function RunCard({ run, preview, session, nativeFiles, records }: {
  records?: ReactNode; run: Run; preview: (id: string) => void; session?: (id: string) => void; nativeFiles: boolean;
}) {
  return <div className="run-card">
    <p className="muted run-time">{timestamp(run.startedAt)}{run.modelStatus && ` · ${hostName} ${run.modelStatus}`}</p>
    {run.deadline!=null&&<p className="muted">{msg("时段截止")} {timestamp(new Date(run.deadline).toISOString())}</p>}
    {run.parentRunId&&<p className="muted">{msg("续接运行")} {run.parentRunId}</p>}
    {run.stopReason==="window"&&<p className="muted">{msg("时段已结束 ·")} {run.status==="paused"?(run.checkpointSafe?msg("已登记可续跑的检查点"):msg("请核对部分产物后手动恢复")):msg("已记录停止意图")}</p>}
    {run.route && <p className="muted">{run.route.kind==="resume"?msg("沿用已有会话"):msg("新建会话")} · {run.route.reason}</p>}
    {run.permission && <p className="muted">{msg("本轮权限 ·")} {msg(permissionLabel(run.permission) ?? "")}</p>}
    {run.effectiveModel && <p className="muted run-time">{msg("执行模型")} {run.effectiveModel}{run.effectiveEffort && msg(" · {0}强度", effortLabel(run.effectiveEffort))}</p>}
    {run.summary && <p className="prose">{run.summary}</p>}
    {Boolean(run.refinementAttachments?.length) && <section className="run-files" aria-label={msg("本轮补充附件")}>
      <h5>{msg("本轮补充附件")}</h5>
      {run.refinementAttachments?.map(file => <div key={file.id} className="run-file">
        <FileIcon name={file.fileName} size={15}/><span>{file.fileName}</span><span className="tag">v{file.revision}</span>
        {nativeFiles && <button type="button" className="ghost" onClick={() => preview(file.id)} aria-label={msg("预览补充附件 {0} v{1}", file.fileName, file.revision)}>{msg("预览")}</button>}
      </div>)}
    </section>}
    {records}
    <Usage runs={[run]} title={msg("本次用量")} />
    {run.error && <p className="inline-error">{systemText(run.error)}</p>}
    {run.files.length > 0 && <div className="run-files">
      {run.files.map(file => <div key={file.id} className="run-file">
        <FileIcon name={file.path} size={15} /><span>{file.path}</span><span className="tag">{file.role === "handoff" ? msg("交接") : `v${file.revision}`}</span>
        {nativeFiles && <button className="ghost" onClick={() => preview(file.id)} aria-label={msg("预览产物 {0}", file.path)}>{msg("预览")}</button>}
      </div>)}
    </div>}
    {run.checks.length > 0 && <section className="checks">
      <h5>{msg("验收证据")} <span className="muted">{run.checks.filter(check => check.passed).length} / {run.checks.length}</span></h5>
      <ul>{run.checks.map((check, index) => <li key={index}>
        <span className={check.passed ? "check-pass" : "check-fail"}>{check.passed ? msg("通过") : msg("失败")}</span>
        <div>{systemText(check.label)}{check.detail && <p className="muted">{check.label.startsWith("人工验收") ? check.detail : systemText(check.detail)}</p>}</div>
      </li>)}</ul>
    </section>}
    {run.reviewNote && !run.checks.some(check => check.detail === run.reviewNote) &&
      <p className="prose">{run.reviewNote}</p>}
    {run.threadId && session && <button className="run-session" onClick={() => session(run.id)}>
      <Icon name="external" size={15} />{msg("跳转")} {hostName} {msg("会话")}
    </button>}
  </div>;
}


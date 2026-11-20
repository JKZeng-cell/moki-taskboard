import { msg, systemText } from "./i18n.ts";
import { DeliveryPreviews } from "./delivery-previews.tsx";
import type { ConversationFile, Run, Task } from "../types.ts";
import { Disclosure, Icon, timestamp } from "./common.tsx";

export function Acceptance({ task, run, files, preview, conversationDone }: { files?:ConversationFile[]; conversationDone?:boolean; task: Task; run?: Run; preview?: (id: string) => void }) {
  const criteria = run?.criteria ?? task;
  const checks = (run?.checks ?? []).filter((check) => !check.label.startsWith("人工验收"));
  const rules = [
    ...criteria.expectedFiles.map((path) => "必交文件 " + path),
    ...criteria.textChecks.map((r) => "内容检查 " + r.path),
  ];
  const recorded = checks.map((check) => check.label);
  const waiting = rules.filter((label) => {
    const i = recorded.indexOf(label);
    if (i < 0) return true;
    recorded.splice(i, 1);
    return false;
  });
  const passed = checks.filter((c) => c.passed).length,
    failed = checks.length - passed;
  const counts = [
    { name: msg("通过"), count: passed, kind: "pass" },
    { name: msg("失败"), count: failed, kind: "fail" },
    { name: msg("未核验"), count: waiting.length, kind: "pending" },
  ];
  const reviews = task.reviews.filter((item) => item.runId === (run?.id ?? null));
  const completed = run?.status === "done";
  const human = completed ? reviews.findLast(item => item.decision === "accept") : reviews.at(-1);
  const olderAcceptance = completed && !human ? run.checks.findLast(check => check.passed && check.label === "人工验收通过") : undefined;
  const humanState = human ? { accept: msg("已通过"), return: msg("已退回"), refine: msg("已补充需求") }[human.decision]
    : olderAcceptance ? msg("已通过")
    : conversationDone ? msg("用户在会话中确认完成")
    : !completed && (task.status === "review" || criteria.reviewCriteria) ? msg("待人工验收") : "";
  return (
    <section className="acceptance" aria-label={msg("验收概览")}>
      <header className="row between">
        <h4>
          <Icon name="task" size={15} />
          {msg("验收概览")}
        </h4>
        <span className="muted">
          {checks.length || waiting.length
            ? msg("{0} / {1} 项通过", passed, checks.length + waiting.length)
            : msg("暂无自动核验记录")}
        </span>
      </header>
      <DeliveryPreviews projectId={task.projectId} run={run} files={files} preview={preview}/>
      {(checks.length > 0 || waiting.length > 0) && (
        <>
          <div
            className="check-meter"
            role="img"
            aria-label={counts.map((c) => c.name + " " + c.count + msg(" 项")).join("，")}
          >
            {counts
              .filter((c) => c.count)
              .map((c) => (
                <i key={c.kind} data-kind={c.kind} style={{ flex: c.count }} />
              ))}
          </div>
          <div className="check-legend">
            {counts.map((c) => (
              <span key={c.kind}>
                <i data-kind={c.kind} />
                {c.name} {c.count}
              </span>
            ))}
          </div>
          <Disclosure title={msg("逐项核验")} meta={failed ? msg("{0} 项失败", failed) : undefined}>
            <ul className="evidence-lines">
              {[
                ...checks.map((c) => ({ ...c, kind: c.passed ? "pass" : "fail", state: c.passed ? msg("通过") : msg("失败") })),
                ...waiting.map((label) => ({ label, detail: msg("等待执行证据"), kind: "pending", state: msg("未核验") })),
              ].map((c, i) => (
                <li key={i}>
                  <strong data-kind={c.kind}>{c.state}</strong>
                  <div>
                    {systemText(c.label)}
                    {c.detail && <small>{systemText(c.detail)}</small>}
                  </div>
                </li>
              ))}
            </ul>
          </Disclosure>
        </>
      )}
      {humanState && (
        <div className="human-check">
          <div className="row between">
            <b>{conversationDone && !human ? msg("完成依据") : msg("人工验收")}</b>
            <span>{humanState}</span>
          </div>
          {criteria.reviewCriteria && <p className="prose">{criteria.reviewCriteria}</p>}
          {human && <small>{timestamp(human.createdAt)}{human.note && " · " + human.note}</small>}
          {olderAcceptance?.detail && <small>{olderAcceptance.detail}</small>}
        </div>
      )}
    </section>
  );
}

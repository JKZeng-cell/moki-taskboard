import { msg } from "./i18n.ts";
import { hostName } from "../host-identity.ts";
import { useState } from "react";
import type { Policy, TimeWindow } from "../schedule.ts";
import type { Params, Project } from "../types.ts";
import { action, pick } from "./bridge.ts";
import { Notice } from "./common.tsx";

const dayNames = ["一", "二", "三", "四", "五", "六", "日"];
export function PolicyForm({
  project,
  policy,
  busy,
  save,
}: {
  project: Project;
  policy: Policy;
  busy: boolean;
  save: (values: Params) => void;
}) {
  const [value, setValue] = useState(policy);
  return <form className="policy-form" onSubmit={event => {
    event.preventDefault(); save({...value,id:project.id});
  }}>
    <PolicyFields project={project} value={value} change={setValue}/>
    <div className="actions"><button className="primary" disabled={busy}>{msg("保存设置")}</button></div>
  </form>;
}

export function PolicyFields({project,value,change}:{project:Pick<Project,"id"|"root">;value:Policy;change:(value:Policy)=>void}) {
  const [paths, setPaths] = useState(value.roots.join("\n"));
  const [trees, setTrees] = useState<string[]>([]);
  const [problem, setProblem] = useState("");
  const roots = value.roots;
  const update = (patch: Partial<Policy>) => change({...value,...patch});
  const changePaths = (raw:string) => {
    setPaths(raw);
    update({roots:raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)});
  };
  const row = (i: number, patch: Partial<TimeWindow>) =>
    update({ windows: value.windows.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const addRoots = (extra: string[]) => changePaths([...new Set([...roots,...extra])].join("\n"));
  return (
    <div className="policy-form">
      <Notice error={problem} />
      <label>
        {msg("执行方式")}
        <select value={value.mode} onChange={(e) => update({ mode: e.target.value as Policy["mode"] })}>
          <option value="manual">{msg("手动")}</option>
          <option value="auto">{msg("自动处理队列")}</option>
          <option value="window">{msg("指定时段处理队列")}</option>
        </select>
      </label>
      <label className="inline-check">
        <input type="checkbox" checked={value.paused} onChange={(e) => update({ paused: e.target.checked })} />
        {msg("暂停新任务派发")}
      </label>
      {value.paused && value.reason && <p className="muted">{value.reason}</p>}
      {value.mode === "window" && (
        <fieldset className="schedule-fields">
          <legend>{msg("每周执行时段")}</legend>
          <label>
            {msg("时区")}
            <input
              value={value.zone}
              required
              onChange={(e) => update({ zone: e.target.value })}
              placeholder="Asia/Shanghai"
            />
          </label>
          {value.windows.map((w, i) => (
            <div key={i} className="window-row">
              <div className="weekdays" aria-label={msg("时段 {0} 的日期", i + 1)}>
                {dayNames.map((name, index) => (
                  <button
                    type="button"
                    key={name}
                    aria-label={msg("周{0}", msg(name))}
                    aria-pressed={w.days.includes(index + 1)}
                    onClick={() =>
                      row(i, {
                        days: w.days.includes(index + 1)
                          ? w.days.filter((d) => d !== index + 1)
                          : [...w.days, index + 1].sort(),
                      })
                    }
                  >
                    {msg(name)}
                  </button>
                ))}
              </div>
              <div className="row">
                <label>
                  {msg("开始")}
                  <input type="time" required value={w.start} onChange={(e) => row(i, { start: e.target.value })} />
                </label>
                <label>
                  {msg("结束")}
                  <input
                    required
                    value={w.end}
                    placeholder="18:00"
                    maxLength={5}
                    onChange={(e) => row(i, { end: e.target.value })}
                  />
                </label>
                <button type="button" onClick={() => update({ windows: value.windows.filter((_, j) => j !== i) })}>
                  {msg("移除")}
                </button>
              </div>
              {w.end < w.start && <small className="muted">{msg("次日结束")}</small>}
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              update({ windows: [...value.windows, { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }] })
            }
          >
            {msg("添加时段")}
          </button>
        </fieldset>
      )}
      <fieldset>
        <legend>{msg("会话归集")}</legend>
        <label className="inline-check">
          <input type="checkbox" checked={value.capture} onChange={(e) => update({ capture: e.target.checked })} />
          {msg("启用项目会话归集")}
        </label>
        {value.capture && (
          <>
            <label>{msg("会话识别范围")}
              <select value={value.semanticScope ?? "off"} onChange={e => update({ semanticScope: e.target.value as Policy["semanticScope"] })}>
                <option value="off">{msg("按目录规则归集")}</option>
                <option value="roots">{msg("语义识别 · 项目及授权目录")}</option>
                <option value="all">{msg("语义识别 · 所有本机会话")}</option>
              </select>
            </label>
            {value.semanticScope !== "off" && <p className="muted">{msg("识别会使用当前")} {hostName} {msg("账号的模型额度，比较会话内容与项目目标、任务和资产。明确匹配时自动关联，按会话原文划分任务状态，并归集实际使用的资料、交付的文件、工作进展与交接。有歧义时进入「待归属」。")}{value.semanticScope === "all" && msg("此范围包含其他工作目录中的当前账号会话。")}</p>}
            <p className="muted">{msg("项目目录：")}{project.root}</p>
            <label>
              {msg("额外授权目录或工作树")}
              <textarea
                rows={2}
                value={paths}
                onChange={(e) => changePaths(e.target.value)}
                placeholder={msg("每行一个本机目录")}
              />
            </label>
            <div className="row">
              <button
                type="button"
                onClick={() =>
                  void pick("directory")
                    .then((list) => { if (list.length) addRoots(list); setProblem(""); })
                    .catch((e) => setProblem(e.message))
                }
              >
                {msg("选择目录")}
              </button>
              <button
                type="button"
                onClick={() =>
                  void action<string[]>("project.worktrees", { id: project.id })
                    .then((list) => {
                      setTrees(list);
                      setProblem("");
                    })
                    .catch(() => setProblem(msg("未能列出 Git 工作树，可以直接选择目录。")))
                }
              >
                {msg("选择 Git 工作树")}
              </button>
            </div>
            {trees.map((path) => (
              <label className="inline-check" key={path}>
                <input
                  type="checkbox"
                  checked={roots.includes(path) || path === project.root}
                  disabled={path === project.root}
                  onChange={(e) =>
                    e.target.checked ? addRoots([path]) : changePaths(roots.filter((r) => r !== path).join("\n"))
                  }
                />
                {path}
              </label>
            ))}
          </>
        )}
      </fieldset>
    </div>
  );
}

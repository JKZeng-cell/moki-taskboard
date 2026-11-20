import type { Params } from "./types.ts";
import type { Store } from "./store.ts";
import { array, object, text } from "./validation.ts";

export interface TimeWindow {
  days: number[];
  start: string;
  end: string;
}
export interface Policy {
  mode: "manual" | "auto" | "window";
  zone: string;
  windows: TimeWindow[];
  paused: boolean;
  reason: string;
  capture: boolean;
  semanticScope: "off" | "roots" | "all";
  roots: string[];
  version: number;
}
type PolicyRow = Omit<Policy, "windows" | "roots" | "paused" | "capture"> & {
  windows: string;
  roots: string;
  paused: number;
  capture: number;
};
export const modeLabel = { manual: "手动", auto: "自动", window: "时段" };
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export function policyFor(db: Store, projectId: string): Policy {
  const row = db.get<PolicyRow>("SELECT * FROM project_policy WHERE projectId=?", projectId);
  return row
    ? {
        ...row,
        windows: JSON.parse(row.windows),
        roots: JSON.parse(row.roots),
        paused: Boolean(row.paused),
        capture: Boolean(row.capture),
      }
    : {
        mode: "manual",
        zone: localZone,
        windows: [],
        paused: false,
        reason: "",
        capture: false,
        semanticScope: "off",
        roots: [],
        version: 0,
      };
}
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function savePolicy(db: Store, p: Params, roots: string[]) {
  return db.transaction(() => {
    const project = db.project(p.id, true);
    const current = policyFor(db, project.id);
    if (current.version !== p.version) throw new Error("项目设置已更新，请重新打开。");
    const mode = p.mode;
    if (mode !== "manual" && mode !== "auto" && mode !== "window") throw new Error("执行模式无效。");
    const zone = text(p.zone, "时区", 100);
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
    } catch {
      throw new Error("请输入有效的 IANA 时区。");
    }
    const windows = array(p.windows, "每周时段", 32).map((item) => {
      const w = object(item);
      const days = [...new Set(array(w.days, "星期", 7))];
      if (!days.length || days.some((d) => !Number.isInteger(d) || Number(d) < 1 || Number(d) > 7))
        throw new Error("请选择有效的星期。");
      const start = text(w.start, "开始时间", 5),
        end = text(w.end, "结束时间", 5);
      if (!clock.test(start) || !(clock.test(end) || end === "24:00") || start === end)
        throw new Error("时段起止时间无效。");
      return { days, start, end };
    });
    if (mode === "window" && !windows.length) throw new Error("时段模式至少需要一个每周时段。");
    if (typeof p.paused !== "boolean" || typeof p.capture !== "boolean") throw new Error("设置开关无效。");
    const semanticScope = p.semanticScope === undefined ? current.semanticScope : p.semanticScope;
    if (semanticScope !== "off" && semanticScope !== "roots" && semanticScope !== "all") throw new Error("会话识别范围无效。");
    db.write(
      `INSERT INTO project_policy(projectId,mode,zone,windows,paused,reason,capture,roots,semanticScope,version) VALUES(?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(projectId) DO UPDATE SET mode=excluded.mode,zone=excluded.zone,windows=excluded.windows,paused=excluded.paused,
        reason=excluded.reason,capture=excluded.capture,roots=excluded.roots,semanticScope=excluded.semanticScope,version=project_policy.version+1`,
      project.id,
      mode,
      zone,
      JSON.stringify(windows),
      Number(p.paused),
      p.paused ? current.reason || "手动暂停" : "",
      Number(p.capture),
      JSON.stringify(roots),
      semanticScope,
    );
    const updated = policyFor(db, project.id);
    if (updated.mode === "window") {
      const at = Date.now(),
        window = scheduleWindow(updated, at),
        limit = window.open ? window.next : at;
      if (limit !== null)
        db.write(
          "UPDATE runs SET deadline=? WHERE projectId=? AND status IN ('running','recover') AND (deadline IS NULL OR deadline>?)",
          limit,
          project.id,
          limit,
        );
    }
    return updated;
  });
}
const week = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const calendars = new Map<string, Intl.DateTimeFormat>();
const spans = new Map<string, { from: number; until: number; next: number | null; open: boolean }>();
export function scheduleWindow(
  policy: Pick<Policy, "mode" | "zone" | "windows">,
  at: number,
): { open: boolean; next: number | null } {
  if (policy.mode !== "window") return { open: true, next: null };
  const key = JSON.stringify([policy.zone, policy.windows]);
  const cached = spans.get(key);
  if (cached && cached.from <= at && at < cached.until) return { open: cached.open, next: cached.next };
  let fmt = calendars.get(policy.zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: policy.zone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    calendars.set(policy.zone, fmt);
  }
  const active = (t: number) => {
    const parts = fmt.formatToParts(t);
    const day = week.indexOf(parts.find((p) => p.type === "weekday")!.value) || 7;
    const hm = parts.find((p) => p.type === "hour")!.value + ":" + parts.find((p) => p.type === "minute")!.value;
    return policy.windows.some((w) =>
      w.start < w.end
        ? w.days.includes(day) && hm >= w.start && hm < w.end
        : (w.days.includes(day) && hm >= w.start) || (w.days.includes(day === 1 ? 7 : day - 1) && hm < w.end),
    );
  };
  const from = Math.floor(at / 60000) * 60000,
    open = active(from);
  let next = from + 60000;
  const horizon = from + 15 * 86400000;
  while (next <= horizon && active(next) === open) next += 60000;
  if (spans.size > 128) spans.clear();
  const boundary = next <= horizon ? next : null;
  spans.set(key, { from, until: boundary ?? horizon, next: boundary, open });
  return { open, next: boundary };
}

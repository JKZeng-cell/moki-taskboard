import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { activityPeriods, activityRange, activityRanges, activityStart, calendarWeeks, localDay } from "../calendar.ts";
import type { ActivityPeriod, ActivityUnit, ActivityWeeks } from "../calendar.ts";
import type { ActivityDay, Task } from "../types.ts";
import { Status } from "./common.tsx";
import { msg, uiDate, uiDateRange } from "./i18n.ts";

const units = { day: "按日", week: "按周", month: "按月" } as const;
const captions = { day: "同一任务每日计一次", week: "同一任务每周计一次", month: "同一任务每月计一次" };
const dateOf = (day: string) => new Date(day + "T12:00:00");
const taskCount = (count: number) => count === 1 ? msg("1 项任务") : msg("{0} 项任务", count);

function periodLabel(period: ActivityPeriod, unit: ActivityUnit, today: string) {
  if (unit === "day") return uiDate(dateOf(period.start), { month: "long", day: "numeric", weekday: "short",
    year: period.start.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" });
  return uiDateRange(dateOf(period.start), dateOf(period.end), { year: "numeric", month: "short", day: "numeric" });
}

function activityLevel(count: number) {
  if (!count) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

function HeatPlot({ weeks, periods, unit, selected, select }: {
  weeks: string[][]; periods: ActivityPeriod[]; unit: ActivityUnit; selected: ActivityPeriod;
  select: (period: ActivityPeriod) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<string | null>(null);
  const daily = unit === "day", short = daily && weeks.length <= 4;
  const wide = daily && weeks.length > 13;
  const columns = Math.min(periods.length, 6);
  const today = periods.at(-1)!.end;
  const cellStyle = { "--heat-weeks": weeks.length, "--period-columns": columns } as CSSProperties;

  // Keep the selection visible inside the chart without scrolling the dashboard.
  useLayoutEffect(() => {
    const scroller = viewport.current;
    const cell = scroller?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!scroller || !cell) return;
    const bounds = scroller.getBoundingClientRect(), target = cell.getBoundingClientRect();
    const weekdays = wide ? scroller.querySelector(".heat-weekdays") : null;
    const left = bounds.left + (weekdays?.getBoundingClientRect().width ?? 0);
    if (target.right > bounds.left + scroller.clientWidth) scroller.scrollLeft += target.right - bounds.left - scroller.clientWidth + 3;
    else if (target.left < left) scroller.scrollLeft += target.left - left - 3;
    if (target.bottom > bounds.top + scroller.clientHeight) scroller.scrollTop += target.bottom - bounds.top - scroller.clientHeight + 3;
    else if (target.top < bounds.top) scroller.scrollTop += target.top - bounds.top - 3;
  }, [unit, weeks.length, selected.start, wide]);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "Escape") { setTip(null); return; }
    const horizontal = daily && !short ? 7 : 1;
    const vertical = daily ? (short ? 7 : 1) : columns;
    const destinations: Record<string, number> = { ArrowLeft: index - horizontal, ArrowRight: index + horizontal,
      ArrowUp: index - vertical, ArrowDown: index + vertical, Home: 0, End: periods.length - 1 };
    if (!Object.hasOwn(destinations, event.key)) return;
    event.preventDefault();
    const next = periods[Math.min(periods.length - 1, Math.max(0, destinations[event.key]))];
    select(next);
    viewport.current?.querySelector<HTMLButtonElement>(`[data-period="${next.start}"]`)?.focus({ preventScroll: true });
  }

  function cell(period: ActivityPeriod, index: number) {
    const count = period.taskIds.length, full = periodLabel(period, unit, today);
    const label = msg("{0}，{1}", daily ? period.start : full, taskCount(count));
    let face = "";
    if (short) face = String(Number(period.start.slice(-2)));
    if (unit === "week") face = uiDate(dateOf(period.start), { month: "numeric", day: "numeric" });
    if (unit === "month") {
      const showYear = periods[0].start.slice(0, 4) !== today.slice(0, 4) && (index === 0 || period.start.slice(5, 7) === "01");
      face = uiDate(dateOf(period.start), showYear ? { month: "numeric", year: "2-digit" } : { month: "short" });
    }
    const column = short ? index % 7 : Math.floor(index / 7);
    return <button key={period.start} type="button" className={daily ? "heat-cell" : "heat-period-cell"} data-period={period.start}
      data-day={daily ? period.start : undefined} data-level={activityLevel(count)} aria-label={label} title={daily ? undefined : label}
      aria-pressed={selected === period} tabIndex={selected === period ? 0 : -1}
      onPointerEnter={e => { if (daily && e.pointerType !== "touch") setTip(period.start); }} onPointerLeave={() => setTip(null)}
      onFocus={e => { if (daily && e.currentTarget.matches(":focus-visible")) setTip(period.start); }} onBlur={() => setTip(null)}
      onClick={() => select(period)} onKeyDown={e => navigate(e, index)}>
      {face}
      {daily && tip === period.start && <span className="heat-tooltip" aria-hidden="true" data-below={wide && index % 7 < 3}
        data-edge={column < 2 ? "start" : column >= (short ? 7 : weeks.length) - 2 ? "end" : undefined}>
        {full}<strong>{taskCount(count)}</strong>
      </span>}
    </button>;
  }

  return <div className="activity-chart" style={cellStyle}>
    <div className={daily ? "heat-viewport" : "heat-period-viewport"} ref={viewport} data-wide={wide} role="group" aria-label={msg("任务活动热力图")}>
      {daily ? <div className="heat-plot" data-short={short}>
        <div className="heat-weekdays" aria-hidden="true">
          {weeks[0].map((day, i) => <span key={day}>{short ? uiDate(dateOf(day), { weekday: "short" }) :
            (i % 2 === 0 && i < 5 ? uiDate(dateOf(day), { weekday: "narrow" }) : "")}</span>)}
        </div>
        <div className="heat-container">
          {periods.map(cell)}
          {weeks.at(-1)!.filter(day => day > today).map(day => <span key={day} className="heat-future" aria-hidden="true"/>)}
        </div>
        {short ? <small className="heat-short-dates">{uiDateRange(dateOf(periods[0].start), dateOf(today), { month: "short", day: "numeric" })}</small>
          : <div className="heat-months" aria-hidden="true">{weeks.map((week, i) => {
            const first = week.find(day => day.endsWith("-01") && day <= today);
            const day = first ?? (i === 0 && !weeks[1].some(d => d.endsWith("-01")) ? week[0] : null);
            if (!day) return null;
            const last = i === weeks.length - 1;
            return <span key={day} style={{ gridColumn: `${last ? i : i + 1} / span 2`, textAlign: last ? "end" : "start" }}>
              {uiDate(dateOf(day), { month: "short" })}
            </span>;
          })}</div>}
      </div> : <div className="heat-period-grid">{periods.map(cell)}</div>}
    </div>
    <div className="heat-caption"><small>{msg(captions[unit])}</small>
      <span className="heat-legend" aria-label={msg("任务数从少到多")}>{msg("少")}{[0, 1, 2, 3, 4].map(level =>
        <i key={level} data-level={level} aria-hidden="true"/>)}{msg("多")}</span>
    </div>
  </div>;
}

export function ActivityCalendar({ activity, tasks, open, range, loadedWeeks, changeRange }: {
  activity: ActivityDay[]; tasks: Task[]; open: (id: string) => void;
  range: ActivityWeeks; loadedWeeks: number; changeRange: (range: ActivityWeeks) => void;
}) {
  const [unit, setUnit] = useState<ActivityUnit>("day");
  const [selectedDay, setSelectedDay] = useState("");
  const today = localDay(new Date());
  const weeks = useMemo(() => calendarWeeks(dateOf(today), range), [today, range]);
  const periods = useMemo(() => activityPeriods(weeks, today, unit, activity), [weeks, today, unit, activity]);
  const anchor = selectedDay >= weeks[0][0] && selectedDay <= today ? selectedDay : today;
  const selected = periods.find(p => p.start <= anchor && p.end >= anchor)!;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const label = periodLabel(selected, unit, today);
  const loading = loadedWeeks < range;

  function switchRange(next: ActivityWeeks) {
    if (anchor < localDay(activityStart(dateOf(today), next))) setSelectedDay(today);
    changeRange(next);
  }

  return <section className="panel activity-panel" aria-label={msg("任务活动")}>
    <div className="section-heading heat-heading"><h2>{msg("任务活动")}</h2>
      <div className="heat-controls">
        <div className="heat-units" role="group" aria-label={msg("时间维度")}>
          {(Object.keys(units) as ActivityUnit[]).map(value => <button key={value} type="button" aria-pressed={unit === value}
            onClick={() => setUnit(value)}>{msg(units[value])}</button>)}
        </div>
        <select aria-label={msg("活动时间范围")} title={msg("包含本周，周一开始")} value={range} onChange={e => switchRange(activityRange(Number(e.target.value)))}>
          {activityRanges.map(value => <option key={value} value={value}>{value === 1 ? msg("本周") : msg("近 {0} 周", value)}</option>)}
        </select>
      </div>
    </div>
    {loading ? <p className="activity-empty" role="status">{msg("正在加载任务活动…")}</p> :
      <div className="activity-body">
        <HeatPlot weeks={weeks} periods={periods} unit={unit} selected={selected} select={p => setSelectedDay(p === selected ? anchor : p.end)}/>
        <div className="heat-selection">
          <div className="activity-day-heading" aria-live="polite" aria-atomic="true">
            <time dateTime={selected.start} title={label}>{label}</time><span>{taskCount(selected.taskIds.length)}</span>
          </div>
          {selected.taskIds.length ? <ul key={unit + selected.start} className="activity-task-list" aria-label={msg("{0} 的活动任务", label)}>
            {selected.taskIds.map(id => {
              const task = byId.get(id), title = task?.title ?? msg("查看任务");
              return <li key={id}><button type="button" className="activity-task" title={title} onClick={() => open(id)}>
                <span className="activity-task-title">{title}</span>
                {task && <span className="activity-task-status"><span className="sr-only">{msg("当前状态，")}</span><Status status={task.status}/></span>}
              </button></li>;
            })}
          </ul> : <p className="activity-empty">{msg(unit === "day" ? "当天暂无任务活动" : "该时段暂无任务活动")}</p>}
        </div>
      </div>}
  </section>;
}

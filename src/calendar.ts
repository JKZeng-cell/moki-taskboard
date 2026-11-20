import type { ActivityDay } from "./types.ts";

export const activityRanges = [1, 4, 13, 26, 52] as const;
export type ActivityWeeks = (typeof activityRanges)[number];
export type ActivityUnit = "day" | "week" | "month";
export const defaultActivityWeeks: ActivityWeeks = 13;

export function activityRange(value: unknown): ActivityWeeks {
  return activityRanges.find(weeks => weeks === value) ?? defaultActivityWeeks;
}

export function localDay(d: Date) {
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,"0"), String(d.getDate()).padStart(2,"0")].join("-");
}

export function activityStart(today: Date, weeks: ActivityWeeks) {
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7 - (weeks - 1) * 7);
  return monday;
}

export function calendarWeeks(today: Date, weeks: ActivityWeeks = defaultActivityWeeks) {
  const cursor = activityStart(today, weeks);
  cursor.setHours(12);
  return Array.from({ length: weeks }, () => Array.from({ length: 7 }, () => {
    const day = localDay(cursor);
    cursor.setDate(cursor.getDate() + 1);
    return day;
  }));
}

export interface ActivityPeriod { start: string; end: string; taskIds: string[] }

export function activityPeriods(weeks: string[][], today: string, unit: ActivityUnit, activity: ActivityDay[]): ActivityPeriod[] {
  const byDay = new Map(activity.map(item => [item.day, item.taskIds]));
  const groups = new Map<string, { start: string; end: string; tasks: Set<string> }>();
  for (const week of weeks) {
    for (const day of week) {
      if (day > today) break;
      const key = unit === "day" ? day : unit === "week" ? week[0] : day.slice(0, 7);
      let group = groups.get(key);
      if (!group) {
        group = { start: day, end: day, tasks: new Set() };
        groups.set(key, group);
      }
      group.end = day;
      for (const id of byDay.get(day) ?? []) group.tasks.add(id);
    }
  }
  return Array.from(groups.values(), group => ({ start: group.start, end: group.end, taskIds: [...group.tasks] }));
}

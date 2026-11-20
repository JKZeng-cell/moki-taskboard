import type { RunStatus, TaskStatus } from "./types.ts";

export const taskStatuses = ["todo", "queued", "running", "review", "done", "error", "paused"] as const;
export const startableStatuses: readonly TaskStatus[] = ["todo", "queued", "running", "error", "paused"];

export function canRefineStatus(status: TaskStatus) {
  return status === "review" || status === "done";
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return taskStatuses.some(status => status === value);
}

export function runControlsStatus(status: RunStatus) {
  return status === "running" || status === "recover" || status === "review";
}

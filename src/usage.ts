import type { Run } from "./types.ts";

type Reading = Pick<Run, "startedAt" | "endedAt" | "status" | "turnDurationMs" | "totalTokens" | "inputTokens" | "outputTokens">;

export function summarizeUsage(runs: Reading[], at = Date.now()) {
  let reported = 0;
  let tokens = 0;
  let input = 0;
  let output = 0;
  let elapsed = 0;
  let timed = 0;
  let estimated = 0;
  for (const run of runs) {
    if (run.totalTokens !== null) {
      reported++;
      tokens += run.totalTokens;
      input += run.inputTokens ?? 0;
      output += run.outputTokens ?? 0;
    }
    if (run.turnDurationMs !== null) {
      timed++;
      elapsed += run.turnDurationMs;
      continue;
    }
    const start = Date.parse(run.startedAt);
    const end = run.endedAt ? Date.parse(run.endedAt) : run.status === "running" ? at : NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      timed++;
      estimated++;
      elapsed += end - start;
    }
  }
  return { count: runs.length, reported, tokens, input, output, timed, estimated, elapsed };
}

export function formatDuration(ms: number, locale = "zh-CN") {
  if (locale === "en-US") {
    const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60);
    if (ms > 0 && !seconds) return "< 1 sec";
    if (minutes >= 60) return Math.floor(minutes / 60) + " hr" + (minutes % 60 ? " " + minutes % 60 + " min" : "");
    return minutes ? minutes + " min " + seconds % 60 + " sec" : seconds + " sec";
  }
  if (ms > 0 && ms < 1000) return "不足 1 秒";
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  if (hours) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

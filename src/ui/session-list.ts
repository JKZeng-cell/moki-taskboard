import { msg } from "./i18n.ts";
import type { CapturedRef, Link, Source } from "../capture.ts";
import type { BoardState, ConversationFile, Run } from "../types.ts";

export type SessionScope = "linked" | "pending" | "ignored";

interface ThreadHistory {
  id: string;
  link?: Link;
  runs: Run[];
  sources: Source[];
  refs: CapturedRef[];
  files: ConversationFile[];
}

export interface SessionEntry extends ThreadHistory {
  title: string;
  summary: string;
  activity: number;
  searchText: string;
}

export function excerptText(summary: string) {
  return summary.replace(/!?\[([^\]\n]*)\]\((?:<[^>\n]+>|[^)\n]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/(`+|\*\*)([^\n]+?)\1/g, "$2")
    .replace(/\s+/g, " ").trim();
}

export function inScope(entry: SessionEntry, scope: SessionScope) {
  const kind = entry.link?.kind;
  if (scope === "pending") return kind === "candidate";
  if (scope === "ignored") return kind === "ignored";
  return entry.runs.length > 0 || kind === "manual" || kind === "auto";
}

function runActivity(run: Run) {
  return Date.parse(run.endedAt || run.startedAt) || 0;
}

export function projectSessions(board: Pick<BoardState, "sessions" | "runs" | "tasks">) {
  const tasks = new Map(board.tasks.map(task => [task.id, task]));
  const threads = new Map<string, ThreadHistory>();
  function thread(id: string) {
    let history = threads.get(id);
    if (!history) {
      history = { id, runs: [], sources: [], refs: [], files: [] };
      threads.set(id, history);
    }
    return history;
  }
  for (const link of board.sessions.links) thread(link.threadId).link = link;
  for (const run of board.runs) if (run.threadId) thread(run.threadId).runs.push(run);
  for (const source of board.sessions.sources) {
    if (source.status === "active") threads.get(source.threadId)?.sources.push(source);
  }
  for (const ref of board.sessions.refs ?? []) threads.get(ref.threadId)?.refs.push(ref);

  for (const file of board.sessions.files ?? []) threads.get(file.threadId)?.files.push(file);
  const entries = [...threads.values()].map(history => {
    const { id, link, runs, sources, refs, files } = history;
    runs.sort((a, b) => runActivity(b) - runActivity(a));
    const latest = runs[0];
    const taskNames = [...new Set([link?.taskId, ...runs.map(r => r.taskId), ...sources.map(s => s.taskId), ...files.map(f=>f.taskId)])]
      .map(taskId => taskId ? tasks.get(taskId)?.title : undefined).filter(Boolean);
    const name = link?.name.trim();
    const title = name && name !== id ? name : taskNames[0] || msg("会话 {0}", id.slice(0, 8));
    const excerpt = link?.kind === "auto" || link?.kind === "manual" ? link.summary : "";
    const summary = excerpt || latest?.summary || "";
    const activity = Math.max(latest ? runActivity(latest) : 0, (link?.seenAt ?? 0) * 1000);
    const searchText = [id, title, link?.cwd, link?.matchReason, link?.matchQuote, summary, ...taskNames, ...sources.flatMap(s => [s.title, s.evidence, s.recognizedState?.quote]), ...refs.map(r => r.path), ...files.flatMap(f=>[f.path,f.fileName])]
      .filter(Boolean).join("\n").toLocaleLowerCase();
    return { ...history, title, summary, activity, searchText };
  });
  entries.sort((a, b) => b.activity - a.activity || a.title.localeCompare(b.title, "zh-CN", { numeric: true }) || a.id.localeCompare(b.id));
  return { entries, tasks };
}


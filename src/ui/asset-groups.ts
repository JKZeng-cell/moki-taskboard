import { msg } from "./i18n.ts";
import type { Asset, BoardState, Lifecycle } from "../types.ts";

type ProjectFiles = Pick<BoardState, "sessions" | "tasks" | "runs">;
export interface AssetGroup {
  id: string;
  title: string;
  hint?: string;
  lifecycle?: Lifecycle;
  assets: Asset[];
}
export interface AssetOwner {
  id: string;
  title: string;
  lifecycle?: Lifecycle;
  assetIds: Set<string>;
}

export function assetMatches(asset: Asset, term: string) {
  return !term || [asset.name, asset.sourcePath, asset.groupName].some(value => value.toLocaleLowerCase().includes(term));
}

export function versionAssets(assets: Asset[]) {
  const index = new Map<string, string>();
  for (const asset of assets) for (const version of asset.versions) index.set(version.id, asset.id);
  return index;
}

export function relatedAssetGroups(assets: Asset[], owners: AssetOwner[], term: string, unlinkedTitle: string) {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const assigned = new Set<string>(), visible = new Set<string>();
  const titleCounts = new Map<string, number>();
  for (const owner of owners) titleCounts.set(owner.title, (titleCounts.get(owner.title) ?? 0) + 1);
  const groups: AssetGroup[] = [];
  for (const owner of owners) {
    const ownerMatch = [owner.title, owner.id].some(value => value.toLocaleLowerCase().includes(term));
    const members: Asset[] = [];
    for (const id of owner.assetIds) {
      const asset = byId.get(id);
      if (!asset) continue;
      assigned.add(id);
      if (ownerMatch || assetMatches(asset, term)) {
        members.push(asset);
        visible.add(id);
      }
    }
    if (members.length) groups.push({
      id: owner.id, title: owner.title, lifecycle: owner.lifecycle,
      hint: titleCounts.get(owner.title)! > 1 || owner.title === unlinkedTitle ? owner.id.slice(-8) : undefined,
      assets: members
    });
  }
  const unlinked = assets.filter(asset => !assigned.has(asset.id) && (unlinkedTitle.includes(term) || assetMatches(asset, term)));
  if (unlinked.length) groups.push({ id: "", title: unlinkedTitle, assets: unlinked });
  return { groups, count: visible.size + unlinked.length };
}

export function taskAssetGroups(board: ProjectFiles, assets: Asset[], term: string) {
  const versions = versionAssets(assets);
  const owners = new Map<string, AssetOwner>();
  function add(taskId: string | null | undefined, assetId: string | null | undefined) {
    if (taskId && assetId) owners.get(taskId)?.assetIds.add(assetId);
  }
  for (const task of board.tasks) {
    owners.set(task.id, { id: task.id, title: task.title, lifecycle: task.lifecycle, assetIds: new Set() });
    for (const id of task.inputVersionIds) add(task.id, versions.get(id));
  }

  const runTasks = new Map<string, string>(), turnTasks = new Map<string, string>();
  for (const run of board.runs) {
    runTasks.set(run.id, run.taskId);
    if (run.threadId && run.turnId) turnTasks.set(run.threadId + "/" + run.turnId, run.taskId);
    for (const id of run.inputVersionIds ?? []) add(run.taskId, versions.get(id));
    for (const file of run.files) add(run.taskId, file.assetId ?? versions.get(file.id));
  }

  const boundTasks = new Map<string, string>();
  for (const link of board.sessions.links) {
    if (link.taskId && (link.kind === "manual" || link.kind === "auto")) boundTasks.set(link.threadId, link.taskId);
  }
  function linkedTask(threadId: string, turnId: string) {
    return turnTasks.get(threadId + "/" + turnId) ?? boundTasks.get(threadId);
  }
  for (const file of board.sessions.files ?? []) {
    const taskId = file.taskId ?? runTasks.get(file.runId ?? "") ?? linkedTask(file.threadId, file.turnId);
    add(taskId, file.assetId ?? versions.get(file.versionId ?? ""));
  }
  for (const ref of board.sessions.refs ?? []) add(linkedTask(ref.threadId, ref.turnId), versions.get(ref.versionId));
  return relatedAssetGroups(assets, [...owners.values()], term, msg("未关联任务"));
}


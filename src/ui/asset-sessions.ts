import { msg } from "./i18n.ts";
import type { Asset, BoardState } from "../types.ts";
import { relatedAssetGroups, versionAssets } from "./asset-groups.ts";
import { inScope, projectSessions } from "./session-list.ts";

export { assetMatches, type AssetGroup as SessionAssetGroup } from "./asset-groups.ts";

export function sessionAssetGroups(board: Pick<BoardState, "sessions" | "tasks" | "runs" | "assets">, assets: Asset[], term: string) {
  const versions = versionAssets(assets);
  const linked = projectSessions(board).entries.filter(entry => inScope(entry, "linked"));
  const owners = linked.map(entry => {
    const assetIds = new Set<string>();
    const add = (id: string | null | undefined) => { if (id) assetIds.add(id); };
    for (const file of entry.files) add(file.assetId ?? versions.get(file.versionId ?? ""));
    for (const ref of entry.refs) add(versions.get(ref.versionId));
    for (const run of entry.runs) {
      for (const id of run.inputVersionIds ?? []) add(versions.get(id));
      for (const file of run.files) add(file.assetId);
    }
    return { id: entry.id, title: entry.title, assetIds };
  });
  return relatedAssetGroups(assets, owners, term, msg("未关联会话"));
}

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Files } from "./assets.ts";
import type { Store } from "./store.ts";
import type { Asset, AssetEdit, AssetVersion, Params } from "./types.ts";
import { id } from "./validation.ts";

interface Draft extends AssetEdit {
  projectId: string;
  savedId: string | null;
}
export function textAsset(name: string) {
  return /\.(?:md|txt|csv|json|ya?ml|log|toml|css|html|js|ts|py|xml)$/i.test(name);
}
function owned(db: Store, projectId: unknown, assetId: unknown) {
  const project = db.project(projectId, true);
  const asset = db.get<Asset>(
    "SELECT * FROM assets WHERE projectId=? AND id=? AND lifecycle='active'",
    project.id,
    id(assetId),
  );
  if (!asset) throw new Error("找不到可编辑的项目资产。");
  return asset;
}
export async function beginEdit(db: Store, files: Files, p: Params) {
  const asset = owned(db, p.projectId, p.assetId);
  const version = db.version(String(p.projectId), p.versionId);
  if (version.assetId !== asset.id) throw new Error("版本不属于此资产。");
  const draft = randomUUID();
  await files.copyVersion(version, join(files.root, "edits", draft, version.fileName));
  owned(db, p.projectId, p.assetId);
  db.write(
    "INSERT INTO asset_edits(id,projectId,assetId,baseId,fileName,createdAt) VALUES(?,?,?,?,?,?)",
    draft,
    String(p.projectId),
    asset.id,
    version.id,
    version.fileName,
    new Date().toISOString(),
  );
  return readEdit(db, files, { id: draft, projectId: p.projectId });
}
async function draftInfo(db: Store, files: Files, p: Params) {
  const draft = db.get<Draft>("SELECT * FROM asset_edits WHERE id=? AND projectId=?", id(p.id), id(p.projectId));
  if (!draft) throw new Error("编辑副本不存在。");
  owned(db, draft.projectId, draft.assetId);
  return { draft, path: join(files.root, "edits", draft.id, draft.fileName) };
}
export async function readEdit(db: Store, files: Files, p: Params) {
  const { draft, path } = await draftInfo(db, files, p);
  const item = db.version(draft.projectId, draft.baseId);
  const latest = db.get<AssetVersion>(
    "SELECT * FROM asset_versions WHERE assetId=? ORDER BY revision DESC LIMIT 1",
    draft.assetId,
  )!;
  let content: string | null = null;
  if (textAsset(draft.fileName) && item.size <= 128 * 1024) {
    const bytes = await readFile(path);
    if (bytes.length <= 128 * 1024)
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {}
  }
  let latestText: string | null = null;
  if (latest.id !== item.id && textAsset(latest.fileName) && latest.size <= 128 * 1024) {
    try {
      latestText = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(files.blob(latest.sha256)));
    } catch {}
  }
  return {
    id: draft.id,
    path,
    latestText,
    fileName: draft.fileName,
    baseId: item.id,
    baseRevision: item.revision,
    latestId: latest.id,
    latestRevision: latest.revision,
    content,
  };
}
export async function refreshSource(db: Store, files: Files, p: Params) {
  const asset = owned(db, p.projectId, p.assetId);
  if (asset.role !== "user" || !asset.sourcePath) throw new Error("该资产没有可重新导入的源文件。");
  const { file } = await files.importFile(asset.sourcePath);
  return db.transaction(() => {
    owned(db, p.projectId, p.assetId);
    const latest = db.get<AssetVersion>(
      "SELECT * FROM asset_versions WHERE assetId=? ORDER BY revision DESC LIMIT 1",
      asset.id,
    )!;
    if (file.sha256 === latest.sha256) return { versionId: latest.id };
    if (latest.id !== p.expectedLatest) throw new Error("资产已更新，请查看最新版本后再导入。");
    return { versionId: db.addVersion(asset.id, file) };
  });
}
export async function saveEdit(db: Store, files: Files, p: Params) {
  const { draft, path } = await draftInfo(db, files, p);
  if (draft.savedId) return { versionId: draft.savedId };
  // Each submission captures its own bytes so concurrent writers never ingest a partially changed working copy.
  let source = path;
  if (p.content !== undefined) {
    if (!textAsset(draft.fileName) || typeof p.content !== "string" || Buffer.byteLength(p.content) > 128 * 1024)
      throw new Error("文本不是可保存的 UTF-8 小文件。");
    source = join(files.root, "edits", draft.id, randomUUID());
    const original = await readFile(path);
    const bom = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    await writeFile(source, (bom ? "\uFEFF" : "") + p.content, { flag: "wx" });
  }
  const input = p.replacement !== undefined ? (await files.importFile(p.replacement)).file : await files.ingest(source);
  if (p.replacement !== undefined && extname(input.fileName).toLowerCase() !== extname(draft.fileName).toLowerCase())
    throw new Error("请选择相同格式的文件。");
  return db.transaction(() => {
    owned(db, draft.projectId, draft.assetId);
    const saved = db.get<{ savedId: string | null }>("SELECT savedId FROM asset_edits WHERE id=?", draft.id)!.savedId;
    if (saved) return { versionId: saved };
    const latest = db.get<AssetVersion>(
      "SELECT * FROM asset_versions WHERE assetId=? ORDER BY revision DESC LIMIT 1",
      draft.assetId,
    )!;
    const base = db.version(draft.projectId, draft.baseId);
    if (input.sha256 === base.sha256 || input.sha256 === latest.sha256) {
      const versionId = input.sha256 === latest.sha256 ? latest.id : base.id;
      db.write("UPDATE asset_edits SET savedId=? WHERE id=?", versionId, draft.id);
      return { versionId };
    }
    if (latest.id !== (p.expectedLatest ?? base.id))
      return { conflict: true, latestId: latest.id, latestRevision: latest.revision };
    const versionId = db.addVersion(draft.assetId, { ...input, fileName: draft.fileName });
    db.write("UPDATE asset_edits SET savedId=? WHERE id=?", versionId, draft.id);
    return { versionId };
  });
}

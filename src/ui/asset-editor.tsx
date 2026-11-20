import { msg } from "./i18n.ts";
import { hostName } from "../host-identity.ts";
import { useEffect, useState } from "react";
import type { Asset } from "../types.ts";
import { action, openFile, pick } from "./bridge.ts";
import { Notice } from "./common.tsx";

interface Draft {
  id: string;
  path: string;
  fileName: string;
  baseId: string;
  baseRevision: number;
  latestId: string;
  latestRevision: number;
  content: string | null;
  latestText: string | null;
}
export function AssetEditor({
  asset,
  projectId,
  draftId,
  native,
  done,
}: {
  asset: Asset;
  projectId: string;
  draftId: string;
  native: boolean;
  done: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(),
    [body, setBody] = useState(""),
    [replacement, setReplacement] = useState("");
  const [conflict, setConflict] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void action<Draft>("asset.editRead", { projectId, id: draftId })
      .then((d) => {
        if (alive) {
          setDraft(d);
          setBody(d.content ?? "");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [draftId, projectId]);
  async function save(overwrite: boolean) {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await action<{ versionId?: string; conflict?: boolean }>("asset.editSave", {
        projectId,
        id: draft.id,
        ...(replacement ? { replacement } : draft.content !== null && body !== draft.content ? { content: body } : {}),
        ...(overwrite ? { expectedLatest: draft.latestId } : {}),
      });
      if (result.conflict) {
        const latest = await action<Draft>("asset.editRead", { projectId, id: draft.id });
        setDraft(latest);
        setConflict(true);
      } else done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="file-editor">
      <Notice error={error} />
      {draft && (
        <>
          <div className="row between">
            <strong>{asset.name}</strong>
            <span className="tag">{msg("基于 v")}{draft.baseRevision}</span>
          </div>
          {draft.content !== null && !replacement && (
            <label>
              {msg("编辑内容")}
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} spellCheck={false} />
            </label>
          )}
          {draft.content === null && <p className="muted">{msg("编辑副本后，保存到项目即可登记新版本。")}</p>}
          <div className="row">
            {native && (
              <button onClick={() => void openFile(draft).catch((e) => setError(e.message))}>
                {msg("在 {0} 中打开副本", hostName)}
              </button>
            )}
            <button
              onClick={() =>
                void pick("files")
                  .then((list) => {
                    if (list.length) setReplacement(list[0]);
                  })
                  .catch((e) => setError(e.message))
              }
            >
              {msg("选择修改后的文件")}
            </button>
          </div>
          {replacement && (
            <div className="row">
              <small className="path">{replacement}</small>
              <button className="text-button" onClick={() => setReplacement("")}>
                {msg("移除选择")}
              </button>
            </div>
          )}
          {conflict && (
            <div className="version-conflict" role="alert">
              <strong>{msg("资产已有 v")}{draft.latestRevision}</strong>
              <p>{msg("请核对最新版本，再决定是否把当前修改另存为下一版。")}</p>
              {draft.latestText !== null ? (
                <details>
                  <summary>{msg("查看最新版本内容")}</summary>
                  <pre>{draft.latestText}</pre>
                </details>
              ) : (
                native && (
                  <button
                    onClick={() =>
                      void action<{ path: string }>("asset.preview", { projectId, versionId: draft.latestId })
                        .then((x) => openFile(x))
                        .catch((e) => setError(e.message))
                    }
                  >
                    {msg("查看最新版本")}
                  </button>
                )
              )}
            </div>
          )}
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => void save(conflict)}>
              {conflict ? msg("另存为下一版") : msg("保存到项目")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

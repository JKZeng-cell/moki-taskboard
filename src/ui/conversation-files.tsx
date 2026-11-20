import { msg } from "./i18n.ts";
import type { ConversationFile } from "../types.ts";
import { FileIcon } from "./file-icon.tsx";
import { Icon } from "./common.tsx";

export function ConversationFiles({ files, preview, jump }: {
  files:ConversationFile[]; preview?:(versionId:string)=>void; jump?:(threadId:string)=>void;
}) {
  return <div className="conversation-files">{files.map(file=>{
    const name=file.fileName || file.path.split(/[\\/]/).pop() || file.path;
    return <div key={file.id} className="conversation-file">
      <FileIcon name={name} size={15}/><div>
        <div className="conversation-file-line"><span className="tag">{file.role==="material"?msg("资料"):msg("产物")}</span>
          {file.versionId && preview ? <button type="button" className="text-button" title={file.path}
            onClick={()=>preview(file.versionId!)}>{name} · v{file.revision}</button> :
            <strong title={file.path}>{name}{file.revision ? " · v"+file.revision : ""}</strong>}
        </div>
        {file.issue && <small>{msg("待归集 ·")} {file.issue}</small>}
        <details><summary>{msg("来源依据")}</summary><p>{file.quote}</p>
          {file.path!==file.quote && <p>{file.path}</p>}
          {jump && <button type="button" className="text-button" onClick={()=>jump(file.threadId)}>{msg("来源会话")} <Icon name="external" size={12}/></button>}
        </details>
      </div>
    </div>;
  })}</div>;
}


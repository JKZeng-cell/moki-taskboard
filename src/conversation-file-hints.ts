import type { Turn } from "./capture.ts";

export type FileOrigin = "mention" | "attachment" | "written" | "viewed" | "generated";
export interface FileHint { path: string; origin: FileOrigin }
export type FileItem = NonNullable<Turn["items"]>[number];

export function fileHints(item: FileItem, raw: string): FileHint[] {
  const hints = new Map<string, FileHint>();
  function add(path: unknown, origin: FileOrigin) {
    if (typeof path !== "string" || !path.trim() || path.length > 1024 || /[\0\r\n]/.test(path)) return;
    hints.set(path.trim(), {path:path.trim(),origin});
  }
  if (item.type === "userMessage") {
    for (const entry of item.content ?? []) {
      if (entry.type === "localImage" || (entry.type === "mention" && !/^(?:plugin|app|skill|mcp):/i.test(entry.path ?? "")))
        add(entry.path,"attachment");
    }
    const header = /^\s*# Files mentioned by the user:\s*\n([\s\S]*?)^## My request:\s*$/im.exec(raw);
    for (const m of (header?.index===0 ? header[1] : "").matchAll(/^## [^\r\n]+?:[ \t]+((?:[A-Za-z]:[\\/]|\/)[^\r\n]+)$/gm)) add(m[1],"attachment");
  } else if (item.type === "fileChange" && item.status === "completed") {
    for (const file of item.changes ?? []) {
      if (file.kind.type === "add" || file.kind.type === "update") add(file.kind.move_path || file.path,"written");
    }
  } else if (item.type === "imageGeneration" && item.status === "completed") add(item.savedPath,"generated");
  else if (item.type === "imageView") add(item.path,"viewed");
  return [...hints.values()];
}

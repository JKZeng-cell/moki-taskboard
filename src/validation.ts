import { isAbsolute } from "node:path";
import type { Params, TextCheck } from "./types.ts";

export function object(value: unknown): Params {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参数格式无效。");
  return value as Params;
}

export function text(value: unknown, label: string, max: number, optional = false): string {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) {
    throw new Error(`${label}需要有效文本（最多 ${max} 字符）。`);
  }
  return value.trim();
}

export function id(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
    throw new Error("标识无效。");
  }
  return value;
}

export function expectedVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("版本无效，请刷新。");
  return value;
}

export function array(value: unknown, label: string, max = 64): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}列表无效。`);
  return value;
}

export function localPath(value: unknown) {
  const path = text(value, "本地路径", 1024);
  if (!isAbsolute(path) || (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(path)) || path.includes("\0")) {
    throw new Error("请选择本机文件或目录的绝对路径。");
  }
  return path;
}

export function relativeFile(value: unknown) {
  const path = text(value, "相对文件路径", 240).replaceAll("\\", "/");
  if (path.split("/").some(part => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/u.test(part) ||
      /[ .]$/.test(part) || /^(?:con|aux|prn|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`文件路径无效：${path}`);
  }
  return path;
}

export function taskFields(values: Params) {
  return {
    title: text(values.title, "任务标题", 160),
    instructions: text(values.instructions, "任务说明", 18000),
    expectedFiles: [...new Set(array(values.expectedFiles ?? [], "必交文件").map(relativeFile))],
    textChecks: array(values.textChecks ?? [], "内容检查").map(entry => {
      const rule = object(entry);
      return { path: relativeFile(rule.path), contains: text(rule.contains, "内容检查文本", 1000) } satisfies TextCheck;
    }),
    reviewCriteria: text(values.reviewCriteria, "人工验收说明", 8000, true),
    inputVersionIds: [...new Set(array(values.inputVersionIds ?? [], "关联资产").map(id))]
  };
}

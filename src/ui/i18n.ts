import { english } from "./en.ts";

export type UiLocale = "zh-CN" | "en-US";
let platformLanguage: string | undefined;
const listeners = new Set<() => void>();

export function resolveLocale(language: string): UiLocale {
  return /^zh(?:[-_]|$)/i.test(language) ? "zh-CN" : "en-US";
}

function detect(): UiLocale {
  if (typeof window === "undefined") return "zh-CN";
  return resolveLocale(platformLanguage || navigator.languages?.[0] || navigator.language || "en");
}

let current = detect();
export const uiLocale = () => current;
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function syncLanguage() {
  const next = detect(), changed = current !== next;
  current = next;
  document.documentElement.lang = current;
  document.title = msg("MOKI任务台");
  if (changed) for (const listener of listeners) listener();
}

export function setPlatformLanguage(language: string) {
  platformLanguage = language.trim() || undefined;
  syncLanguage();
}

export function msg(source: string, ...values: unknown[]): string {
  const template = current === "en-US" && Object.hasOwn(english, source) ? english[source] : source;
  return values.length ? template.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)])) : template;
}

// Stored service messages use the original Chinese protocol text. Only apply these
// templates to system fields, never to project names, chat text or file content.
const systemPatterns = [
  "交付文件包含链接或目录联接：{0}",
  "交付文件超出输出目录：{0}",
  "文本文件无法读取或超过 {0} 字节：{1}",
  "资产指纹异常：{0}",
  "交付清单有重复路径或无效用途：{0}",
  "Codex 执行环境未能写入隔离目录：{0}",
  "请先恢复资产 {0}。",
  "{0}需要有效文本（最多 {1} 字符）。",
  "{0}列表无效。",
  "文件路径无效：{0}",
  "{0} 文件",
  "必交文件 {0}",
  "内容检查 {0}",
  "核对产物 {0}",
  "{0} 字节 · SHA-256 {1}"
].map(key => {
  const parts = key.split(/\{\d+\}/);
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { key, pattern: new RegExp("^" + parts.map(escape).join("([\\s\\S]+?)") + "$") };
});

export function systemText(source: string) {
  if (!source || current === "zh-CN") return source;
  if (Object.hasOwn(english, source)) return english[source];
  for (const { key, pattern } of systemPatterns) {
    const match = pattern.exec(source);
    if (match) return msg(key, ...match.slice(1));
  }
  return source;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(options: Intl.DateTimeFormatOptions) {
  const key = current + JSON.stringify(options);
  let formatter = formatters.get(key);
  if (!formatter) { formatter = new Intl.DateTimeFormat(current, options); formatters.set(key, formatter); }
  return formatter;
}

export function uiDate(value: Date, options: Intl.DateTimeFormatOptions) {
  return dateFormatter(options).format(value);
}

export function uiDateRange(first: Date, last: Date, options: Intl.DateTimeFormatOptions) {
  return dateFormatter(options).formatRange(first, last);
}

if (typeof window !== "undefined") {
  syncLanguage();
  window.addEventListener("languagechange", syncLanguage);
}

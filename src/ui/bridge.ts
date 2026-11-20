import { msg, setPlatformLanguage, systemText } from "./i18n.ts";
import { hostName } from "../host-identity.ts";
import type { Params } from "../types.ts";
import { isDsh } from "../host-identity.ts";
import { version } from "../version.ts";

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timeout: number };
const pending = new Map<number, Pending>();
let sequence = 0;

export function requestKey() {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return Array.from(bytes, (byte, index) =>
    ([4, 6, 8, 10].includes(index) ? "-" : "") + byte.toString(16).padStart(2, "0")).join("");
}

function send(message: Params) {
  parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
}

function rpc<T>(method: string, params: Params, timeout = 18000): Promise<T> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(hostName+msg(" 宿主未响应，请重试。")));
    }, timeout);
    pending.set(id, { resolve: result => resolve(result as T), reject, timeout: timer });
    send({ id, method, params });
  });
}

type HostContext = { locale?: string; theme?: string; styles?: { variables?: Record<string, string> }; safeAreaInsets?: { bottom?: number } };
const styleNames = ["--font-sans", "--color-background-primary", "--color-background-secondary", "--color-background-tertiary",
  "--color-text-primary", "--color-text-secondary", "--color-text-tertiary", "--color-border-primary",
  "--color-border-secondary", "--color-border-tertiary", "--color-chart-empty", "--color-chart-sequential-1",
  "--color-chart-sequential-2", "--color-chart-sequential-3", "--color-chart-sequential-4", "--border-radius-md", "--border-radius-lg", "--cursor-interaction"] as const;

function theme(context: HostContext | undefined) {
  if (typeof context?.locale === "string") setPlatformLanguage(context.locale);
  if (context?.theme === "light" || context?.theme === "dark") document.documentElement.dataset.theme = context.theme;
  const bottom = context?.safeAreaInsets?.bottom;
  if (typeof bottom === "number" && Number.isFinite(bottom)) {
    document.documentElement.style.setProperty("--host-bottom-inset", Math.max(0, bottom) + "px");
  }
  if (context?.styles?.variables) {
    const variables = context.styles.variables;
    for (const key of styleNames) {
      if (typeof variables[key] === "string") document.documentElement.style.setProperty(key, variables[key]);
      else document.documentElement.style.removeProperty(key);
    }
  }
}

window.addEventListener("message", event => {
  if (event.source !== parent || event.data?.jsonrpc !== "2.0") return;
  const message = event.data;
  if (message.method === "ui/resource-teardown" && message.id !== undefined) send({ id: message.id, result: {} });
  if (message.method === "ui/notifications/host-context-changed") theme(message.params);
  if (message.method || !pending.has(message.id)) return;
  const open = pending.get(message.id)!;
  pending.delete(message.id);
  clearTimeout(open.timeout);
  if (message.error) open.reject(new Error(message.error.message));
  else open.resolve(message.result);
});

export async function connectHost() {
  const value = await rpc<{
    hostContext?: HostContext;
    hostCapabilities?: { experimental?: Record<string, object> };
  }>("ui/initialize", {
    appInfo: { name: "MOKI Taskboard", version },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  });
  theme(value.hostContext);
  send({ method: "ui/notifications/initialized" });
  return { nativeFiles: Boolean(value.hostCapabilities?.experimental?.["openai/files"]) };
}

export async function action<T>(name: string, params: Params = {}): Promise<T> {
  if (isDsh) {
    const response = await fetch("./action", { method:"POST", headers:{"content-type":"application/json","x-moki-taskboard":"1"},
      body:JSON.stringify({action:name,params}), cache:"no-store" });
    const data = await response.json();
    if (!response.ok) throw Error(systemText(data.error || "DSH 任务台连接已失效，请重新打开面板。"));
    return data.value as T;
  }
  const result = await rpc<{ isError?: boolean; content?: { text?: string }[]; structuredContent?: { value: T } }>("tools/call", {
    name: "moki_taskboard_action", arguments: { action: name, params }
  }, ["pick","asset.import","thread.scan","thread.bind"].includes(name) ? 190000 : 39000);
  if (result.isError) throw new Error(systemText(result.content?.[0]?.text || "任务台操作失败。"));
  if (!result.structuredContent) throw new Error(msg("任务台没有返回有效数据。"));
  return result.structuredContent.value;
}

export async function openWebLink(url: string) {
  await rpc("ui/open-link", { url });
}

export async function openFile(file: {path:string;previewTicket?:string}) {
  await rpc("openai/files/open",isDsh?{path:file.path,previewTicket:file.previewTicket}:{path:file.path});
}

export async function openSession(runId: string) {
  const { url } = await action<{ url: string }>("run.session", { runId });
  try { await rpc("ui/open-link", { url }); }
  catch { await action("run.openWindows", { runId }); }
}

export async function openLinkedThread(projectId:string,threadId:string) {
  const params={projectId,threadId};
  const {url}=await action<{url:string}>("thread.session",params);
  try{await rpc("ui/open-link",{url});}catch{await action("thread.openWindows",params);}
}

export async function pick(kind: "files" | "directory") {
  return (await action<{ paths: string[] }>("pick", { kind })).paths;
}

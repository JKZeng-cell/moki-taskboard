import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { errorText } from "./assets.ts";
import { command } from "./ipc.ts";
import { object } from "./validation.ts";
import type { Params } from "./types.ts";
import { version } from "./version.ts";

const uri = `ui://moki-taskboard/${version}/panel.html`;
const resource = { name: "MOKI任务台", uri, mimeType: "text/html;profile=mcp-app" };
const html = readFile(new URL("./panel.html", import.meta.url), "utf8");
const icon = await readFile(new URL("../assets/taskboard-mark.png", import.meta.url));
const icons = [{ src: `data:image/png;base64,${icon.toString("base64")}`, mimeType: "image/png", sizes: ["128x128"] }];
// Let Windows release the installed package directory between tool calls.
process.chdir(tmpdir());
const launchers = [
  ["moki_taskboard_open", "MOKI任务台", "global"],
  ["moki_taskboard_thread", "MOKI任务台会话面板", "thread"]
].map(([name, title, type]) => ({
  name, title, icons, description: "打开本地任务台，管理项目、任务和资产。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: uri }, "openai/outputTemplate": uri, "openai/ui": { entrypoints: [{ type }] } }
}));
const tools = [...launchers, {
  name: "moki_taskboard_action", title: "操作 MOKI任务台", description: "处理任务台面板中的用户操作。",
  inputSchema: {
    type: "object", required: ["action", "params"], additionalProperties: false,
    properties: { action: { type: "string" }, params: { type: "object", additionalProperties: true } }
  },
  _meta: { ui: { visibility: ["app"] } }
}];

const content = (text: string) => [{ type: "text", text }];
let clientLocale = Intl.DateTimeFormat().resolvedOptions().locale;

async function handle(method: string, params: Params) {
  const locale = (params._meta as Params | undefined)?.["openai/locale"];
  if (method === "initialize" && typeof locale === "string") clientLocale = locale;
  const chinese = /^zh(?:[-_]|$)/i.test(typeof locale === "string" ? locale : clientLocale);
  const resourceInfo = chinese ? resource : { ...resource, name: "MOKI Taskboard" };
  switch (method) {
    case "initialize":
      return {
        protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(String(params.protocolVersion))
          ? params.protocolVersion : "2025-11-25",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "moki-taskboard", version, icons }
      };
    case "ping": return {};
    case "tools/list": return { tools: chinese ? tools : tools.map(tool => ({
      ...tool, title: { moki_taskboard_open:"MOKI Taskboard", moki_taskboard_thread:"MOKI Taskboard chat panel",
        moki_taskboard_action:"Taskboard action" }[tool.name],
      description: tool.name === "moki_taskboard_action" ? "Handle an action from the Taskboard panel." : "Open Taskboard to manage projects, tasks and assets."
    })) };
    case "resources/list": return { resources: [resourceInfo] };
    case "resources/templates/list": return { resourceTemplates: [] };
    case "prompts/list": return { prompts: [] };
    case "resources/read": {
      if (params.uri !== uri) throw new Error("找不到任务台资源。");
      return { contents: [{ ...resourceInfo, text: await html }] };
    }
    case "tools/call": {
      if (launchers.some(tool => tool.name === params.name)) {
        return { content: content(chinese ? "已打开 MOKI任务台。" : "MOKI Taskboard opened."), structuredContent: { surface: "taskboard" } };
      }
      if (params.name === "moki_taskboard_action") {
        try {
          const args = object(params.arguments);
          if (typeof args.action !== "string") throw new Error("操作无效。");
          const value = await command(args.action, object(args.params));
          return { content: content(chinese ? "任务台操作已处理。" : "Taskboard action completed."), structuredContent: { value } };
        } catch (error) { return { content: content(errorText(error)), isError: true }; }
      }
      throw new Error("找不到任务台工具。");
    }
    default: throw new Error("Method not found");
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request: Params;
  try { request = object(JSON.parse(line)); } catch { continue; }
  if (request.id === undefined || typeof request.method !== "string") continue;
  const reply = { jsonrpc: "2.0", id: request.id };
  try {
    const result = await handle(request.method, object(request.params ?? {}));
    process.stdout.write(JSON.stringify({ ...reply, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ...reply, error: { code: -32601, message: errorText(error) } }) + "\n");
  }
}

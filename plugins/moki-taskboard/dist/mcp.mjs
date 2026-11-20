// src/mcp.ts
import { readFile as readFile2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

// src/validation.ts
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("\u53C2\u6570\u683C\u5F0F\u65E0\u6548\u3002");
  return value;
}

// src/assets.ts
var errorText = (error) => error instanceof Error ? error.message : String(error);

// src/ipc.ts
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
var dataDir = resolve(process.env.MOKI_TASKBOARD_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "state"), "MOKI", "Taskboard"));
var suffix = createHash("sha256").update(process.platform === "win32" ? dataDir.toLowerCase() : dataDir).digest("hex").slice(0, 24);
var endpoint = process.platform === "win32" ? `\\\\.\\pipe\\moki-taskboard-${suffix}` : join(dataDir, "service.sock");
var protocol = 1;
var maxRequest = 512 * 1024;
async function token() {
  await mkdir(dataDir, { recursive: true, mode: 448 });
  const path = join(dataDir, "ipc-key");
  try {
    await writeFile(path, randomBytes(32).toString("hex"), { mode: 384, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = await readFile(path, "utf8");
    if (/^[0-9a-f]{64}$/.test(key)) return key;
    await delay(30);
  }
  throw new Error("\u672C\u673A\u4EFB\u52A1\u670D\u52A1\u7684 IPC \u5BC6\u94A5\u65E0\u6548\u3002");
}
var ServiceUnavailable = class extends Error {
};
function request(body, timeout) {
  return new Promise((resolve2, reject) => {
    const socket = connect(endpoint);
    let connected = false;
    let received = false;
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () => socket.destroy(new Error("\u4EFB\u52A1\u670D\u52A1\u8BF7\u6C42\u8D85\u65F6\u3002")));
    socket.on("connect", () => {
      connected = true;
      socket.write(body);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 12 * 1024 * 1024) socket.destroy(new Error("\u4EFB\u52A1\u670D\u52A1\u8FD4\u56DE\u7684\u6570\u636E\u8FC7\u5927\u3002"));
      const end = response.indexOf("\n");
      if (end < 0 || received) return;
      received = true;
      socket.end();
      try {
        const result = JSON.parse(response.slice(0, end));
        if (result.ok) resolve2(result.value);
        else reject(new Error(result.error || "\u4EFB\u52A1\u670D\u52A1\u64CD\u4F5C\u5931\u8D25\u3002"));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => reject(connected ? error : new ServiceUnavailable(error.message)));
    socket.on("end", () => {
      if (!received) reject(new Error("\u4EFB\u52A1\u670D\u52A1\u63D0\u524D\u65AD\u5F00\u3002"));
    });
  });
}
var booting;
async function startService(key) {
  const executable = fileURLToPath(new URL("./service.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", executable], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", () => {
  });
  child.unref();
  const health = JSON.stringify({ protocol, key, action: "health", params: {} }) + "\n";
  for (let attempt = 0; attempt < 22; attempt++) {
    await delay(145);
    try {
      await request(health, 4e3);
      return;
    } catch (error) {
      if (!(error instanceof ServiceUnavailable)) throw error;
    }
  }
  throw new Error("\u65E0\u6CD5\u542F\u52A8\u672C\u673A\u4EFB\u52A1\u670D\u52A1\u3002\u8BF7\u67E5\u770B\u4EFB\u52A1\u53F0\u6570\u636E\u76EE\u5F55\u4E2D\u7684 service.log\u3002");
}
async function command(action, params = {}) {
  const key = await token();
  const body = JSON.stringify({ protocol, key, action, params }) + "\n";
  const timeout = ["pick", "asset.import", "thread.scan", "thread.bind"].includes(action) ? 18e4 : 3e4;
  try {
    return await request(body, timeout);
  } catch (error) {
    if (!(error instanceof ServiceUnavailable)) throw error;
  }
  if (!booting) {
    booting = startService(key).finally(() => {
      booting = void 0;
    });
  }
  await booting;
  return request(body, timeout);
}

// src/version.ts
var version = typeof __MOKI_DSH_VERSION__ === "string" ? __MOKI_DSH_VERSION__ : "0.2.23";

// src/mcp.ts
var uri = `ui://moki-taskboard/${version}/panel.html`;
var resource = { name: "MOKI\u4EFB\u52A1\u53F0", uri, mimeType: "text/html;profile=mcp-app" };
var html = readFile2(new URL("./panel.html", import.meta.url), "utf8");
var icon = await readFile2(new URL("../assets/taskboard-mark.png", import.meta.url));
var icons = [{ src: `data:image/png;base64,${icon.toString("base64")}`, mimeType: "image/png", sizes: ["128x128"] }];
process.chdir(tmpdir());
var launchers = [
  ["moki_taskboard_open", "MOKI\u4EFB\u52A1\u53F0", "global"],
  ["moki_taskboard_thread", "MOKI\u4EFB\u52A1\u53F0\u4F1A\u8BDD\u9762\u677F", "thread"]
].map(([name, title, type]) => ({
  name,
  title,
  icons,
  description: "\u6253\u5F00\u672C\u5730\u4EFB\u52A1\u53F0\uFF0C\u7BA1\u7406\u9879\u76EE\u3001\u4EFB\u52A1\u548C\u8D44\u4EA7\u3002",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: uri }, "openai/outputTemplate": uri, "openai/ui": { entrypoints: [{ type }] } }
}));
var tools = [...launchers, {
  name: "moki_taskboard_action",
  title: "\u64CD\u4F5C MOKI\u4EFB\u52A1\u53F0",
  description: "\u5904\u7406\u4EFB\u52A1\u53F0\u9762\u677F\u4E2D\u7684\u7528\u6237\u64CD\u4F5C\u3002",
  inputSchema: {
    type: "object",
    required: ["action", "params"],
    additionalProperties: false,
    properties: { action: { type: "string" }, params: { type: "object", additionalProperties: true } }
  },
  _meta: { ui: { visibility: ["app"] } }
}];
var content = (text2) => [{ type: "text", text: text2 }];
var clientLocale = Intl.DateTimeFormat().resolvedOptions().locale;
async function handle(method, params) {
  const locale = params._meta?.["openai/locale"];
  if (method === "initialize" && typeof locale === "string") clientLocale = locale;
  const chinese = /^zh(?:[-_]|$)/i.test(typeof locale === "string" ? locale : clientLocale);
  const resourceInfo = chinese ? resource : { ...resource, name: "MOKI Taskboard" };
  switch (method) {
    case "initialize":
      return {
        protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(String(params.protocolVersion)) ? params.protocolVersion : "2025-11-25",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "moki-taskboard", version, icons }
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: chinese ? tools : tools.map((tool) => ({
        ...tool,
        title: {
          moki_taskboard_open: "MOKI Taskboard",
          moki_taskboard_thread: "MOKI Taskboard chat panel",
          moki_taskboard_action: "Taskboard action"
        }[tool.name],
        description: tool.name === "moki_taskboard_action" ? "Handle an action from the Taskboard panel." : "Open Taskboard to manage projects, tasks and assets."
      })) };
    case "resources/list":
      return { resources: [resourceInfo] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    case "resources/read": {
      if (params.uri !== uri) throw new Error("\u627E\u4E0D\u5230\u4EFB\u52A1\u53F0\u8D44\u6E90\u3002");
      return { contents: [{ ...resourceInfo, text: await html }] };
    }
    case "tools/call": {
      if (launchers.some((tool) => tool.name === params.name)) {
        return { content: content(chinese ? "\u5DF2\u6253\u5F00 MOKI\u4EFB\u52A1\u53F0\u3002" : "MOKI Taskboard opened."), structuredContent: { surface: "taskboard" } };
      }
      if (params.name === "moki_taskboard_action") {
        try {
          const args = object(params.arguments);
          if (typeof args.action !== "string") throw new Error("\u64CD\u4F5C\u65E0\u6548\u3002");
          const value = await command(args.action, object(args.params));
          return { content: content(chinese ? "\u4EFB\u52A1\u53F0\u64CD\u4F5C\u5DF2\u5904\u7406\u3002" : "Taskboard action completed."), structuredContent: { value } };
        } catch (error) {
          return { content: content(errorText(error)), isError: true };
        }
      }
      throw new Error("\u627E\u4E0D\u5230\u4EFB\u52A1\u53F0\u5DE5\u5177\u3002");
    }
    default:
      throw new Error("Method not found");
  }
}
var lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request2;
  try {
    request2 = object(JSON.parse(line));
  } catch {
    continue;
  }
  if (request2.id === void 0 || typeof request2.method !== "string") continue;
  const reply = { jsonrpc: "2.0", id: request2.id };
  try {
    const result = await handle(request2.method, object(request2.params ?? {}));
    process.stdout.write(JSON.stringify({ ...reply, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ...reply, error: { code: -32601, message: errorText(error) } }) + "\n");
  }
}

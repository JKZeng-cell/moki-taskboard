import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { errorText } from "./assets.ts";
import type { Params } from "./types.ts";
import { version } from "./version.ts";

const execute = promisify(execFile);

export class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

type Notification = { method: string; params: Params };
type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };

async function desktopExecutable() {
  if (process.platform !== "win32") return undefined;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'\n" +
    "$pkg = Get-AppxPackage 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1\n" +
    "if ($pkg) { Join-Path $pkg.InstallLocation 'app/resources/codex.exe' }"],
  { windowsHide: true, timeout: 12000 });
  const path = stdout.trim();
  if (path) await access(path);
  return path || undefined;
}

async function standaloneExecutable() {
  if (process.platform !== "win32") return "codex";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  for (const roaming of new Set([process.env.APPDATA, join(homedir(), "AppData", "Roaming")])) {
    if (!roaming) continue;
    const vendor = join(roaming, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai",
      `codex-win32-${arch}`, "vendor");
    for (const entry of await readdir(vendor, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const executable = join(vendor, entry.name, "bin", "codex.exe");
      try { await access(executable); return executable; } catch { /* check the next installed runtime */ }
    }
  }
  try {
    const { stdout } = await execute("where.exe", ["codex.exe"], { windowsHide: true, timeout: 5000 });
    const executable = stdout.split(/\r?\n/).map(path => path.trim()).find(path => path && !/WindowsApps/i.test(path));
    if (executable) return executable;
  } catch { /* try the executable on PATH */ }
  return "codex.exe";
}

export async function codexRuntime() {
  const packaged = await desktopExecutable();
  const override = process.env.MOKI_TASKBOARD_CODEX_BIN;
  if (override) await access(override);
  return { packaged, executable: override || packaged || await standaloneExecutable() };
}

export class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Waiting>();
  private sequence = 0;
  private failure: Error | undefined;
  onNotification?: (message: Notification) => void;
  onClose?: (error: Error) => void;
  onRequest?: (method:string,params:Params)=>Promise<unknown>;

  static async open(cwd: string) {
    const { packaged, executable } = await codexRuntime();
    const useDesktop = packaged && resolve(executable).toLowerCase() === resolve(packaged).toLowerCase();
    const args = ["app-server", "--listen", "stdio://"];
    // Use the same registered Windows workspace sandbox service as the desktop app.
    if (useDesktop) args.push("-c", "features.prefer_mxc=true", "-c", "features.windows_sandbox_service=true");
    return new AppServer(executable, cwd, args);
  }

  private constructor(executable: string, cwd: string, args: string[]) {
    this.child = spawn(executable, args, { cwd, windowsHide: true });
    this.child.stderr.resume();
    this.child.on("error", error => this.closed(error));
    this.child.stdin.on("error", error => this.closed(error));
    this.child.on("close", code => this.closed(new Error(`Codex App Server 已退出（${code ?? "已中断"}）。`)));
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", line => this.receive(line));
  }

  private closed(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timeout);
      waiting.reject(error);
    }
    this.pending.clear();
    this.onClose?.(error);
  }

  private send(message: object) {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(line: string) {
    let message: { id?: number | string; method?: string; params?: Params; result?: unknown; error?: { message: string; code: number } };
    try {
      message = JSON.parse(line);
      if (!message || typeof message !== "object") return;
    } catch { return; }
    if (message.method) {
      if (message.id !== undefined) {
        const id=message.id;
        if(this.onRequest)void this.onRequest(message.method,message.params??{}).then(result=>{
          if(!this.failure)this.send({id,result});
        },error=>{if(!this.failure)this.send({id,error:{code:-32601,message:errorText(error)}});});
        else this.send({id,error:{code:-32601,message:"Unsupported client request"}});
      } else {
        try { this.onNotification?.({ method: message.method, params: message.params ?? {} }); }
        catch (error) { this.closed(new Error(errorText(error))); }
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timeout);
    this.pending.delete(message.id);
    if (message.error) waiting.reject(new RpcError(message.error.message, message.error.code));
    else waiting.resolve(message.result);
  }

  call<T = unknown>(method: string, params: Params = {}, deadline = 30000): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 请求超时。`));
      }, deadline);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    const reply = await this.call<{ userAgent?: string }>("initialize", {
      clientInfo: { name: "moki-taskboard", title: "MOKI Taskboard", version }
    });
    this.send({ method: "initialized" });
    return reply;
  }

  close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1500);
    timer.unref();
    this.child.once("close", () => clearTimeout(timer));
  }
}

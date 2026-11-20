import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Params } from "./types.ts";

export const dataDir = resolve(process.env.MOKI_TASKBOARD_DATA_DIR ||
  join(process.env.LOCALAPPDATA || join(homedir(), ".local", "state"), "MOKI", "Taskboard"));
const suffix = createHash("sha256").update(process.platform === "win32" ? dataDir.toLowerCase() : dataDir)
  .digest("hex").slice(0, 24);
export const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\moki-taskboard-${suffix}` : join(dataDir, "service.sock");
export const protocol = 1;
export const maxRequest = 512 * 1024;

export async function token() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "ipc-key");
  try {
    await writeFile(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = await readFile(path, "utf8");
    if (/^[0-9a-f]{64}$/.test(key)) return key;
    await delay(30);
  }
  throw new Error("本机任务服务的 IPC 密钥无效。");
}

class ServiceUnavailable extends Error {}

function request<T>(body: string, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let connected = false;
    let received = false;
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () => socket.destroy(new Error("任务服务请求超时。")));
    socket.on("connect", () => { connected = true; socket.write(body); });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 12 * 1024 * 1024) socket.destroy(new Error("任务服务返回的数据过大。"));
      const end = response.indexOf("\n");
      if (end < 0 || received) return;
      received = true;
      socket.end();
      try {
        const result = JSON.parse(response.slice(0, end)) as { ok: boolean; value?: T; error?: string };
        if (result.ok) resolve(result.value as T);
        else reject(new Error(result.error || "任务服务操作失败。"));
      } catch (error) { reject(error); }
    });
    socket.on("error", error => reject(connected ? error : new ServiceUnavailable(error.message)));
    socket.on("end", () => { if (!received) reject(new Error("任务服务提前断开。")); });
  });
}

let booting: Promise<void> | undefined;
async function startService(key: string) {
  const executable = fileURLToPath(new URL("./service.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", executable], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  child.on("error", () => {});
  child.unref();
  const health = JSON.stringify({ protocol, key, action: "health", params: {} }) + "\n";
  for (let attempt = 0; attempt < 22; attempt++) {
    await delay(145);
    try { await request(health, 4000); return; }
    catch (error) { if (!(error instanceof ServiceUnavailable)) throw error; }
  }
  throw new Error("无法启动本机任务服务。请查看任务台数据目录中的 service.log。");
}

export async function command<T = unknown>(action: string, params: Params = {}) {
  const key = await token();
  const body = JSON.stringify({ protocol, key, action, params }) + "\n";
  const timeout = ["pick","asset.import","thread.scan","thread.bind"].includes(action) ? 180000 : 30000;
  try { return await request<T>(body, timeout); }
  catch (error) { if (!(error instanceof ServiceUnavailable)) throw error; }
  if (!booting) {
    booting = startService(key).finally(() => { booting = undefined; });
  }
  await booting;
  return request<T>(body, timeout);
}

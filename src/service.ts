import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { appendFile, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { dataDir, endpoint, maxRequest, protocol, token } from "./ipc.ts";
import { Scheduler } from "./scheduler.ts";
import { AppServer } from "./app-server.ts";
import { CaptureService } from "./capture.ts";
import { Runner } from "./runner.ts";
import { availableModels } from "./models.ts";
import { Store } from "./store.ts";

import { Files,errorText } from "./assets.ts";
import { object } from "./validation.ts";
import { createActions } from "./actions.ts";
const execute = promisify(execFile);
const key = await token();
const encodedKey = Buffer.from(key);
let store: Store;
let worker: Runner;
let capture: CaptureService;
const files = new Files(dataDir);
let dispatch: ReturnType<typeof createActions>;
async function launchThread(url:string) {
  if(process.platform!=="win32")throw new Error("本机协议跳转仅适用于 Windows。");
  await execute("powershell.exe",["-NoProfile","-NonInteractive","-Command",`Start-Process -FilePath '${url}' -ErrorAction Stop`],{windowsHide:true,timeout:12000});
}

const listener = createServer(socket => {
  socket.setEncoding("utf8");
  socket.setTimeout(15000, () => socket.destroy());
  socket.on("error", () => {});
  let data = "";
  let handled = false;
  socket.on("data", (chunk: string) => {
    if (handled) return;
    data += chunk;
    if (Buffer.byteLength(data) > maxRequest) { socket.destroy(); return; }
    const end = data.indexOf("\n");
    if (end < 0) return;
    handled = true;
    socket.setTimeout(0);
    void (async () => {
      try {
        const request = object(JSON.parse(data.slice(0, end)));
        const supplied = Buffer.from(typeof request.key === "string" ? request.key : "");
        if (supplied.length !== encodedKey.length || !timingSafeEqual(supplied, encodedKey)) throw new Error("本机连接未授权。");
        if (request.protocol !== protocol) throw new Error("后台和面板的协议版本不同。");
        const value = await dispatch(request.action, object(request.params));
        socket.end(JSON.stringify({ ok: true, value }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: errorText(error) }) + "\n");
      }
    })();
  });
});

try {
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  store = new Store(dataDir);
  worker = new Runner(store, files);
  capture=new CaptureService(store,dataDir);
  dispatch=createActions({store,files,worker,capture,models:()=>availableModels(dataDir),reader:()=>AppServer.open(dataDir),launchThread});
  const scheduler=new Scheduler(store,worker);
  store.write("UPDATE run_approvals SET status='expired' WHERE status='pending'");
  const tick=()=>{try{scheduler.tick();}catch(error){void appendFile(join(dataDir,"service.log"),new Date().toISOString()+" "+errorText(error)+"\n").catch(()=>{});}};
  tick();
  setInterval(tick,1000).unref();
  const scan=()=>{void capture.scan().catch(()=>{});};
  scan();
  setInterval(scan,30000).unref();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
    await appendFile(join(dataDir, "service.log"), `${new Date().toISOString()} ${errorText(error)}\n`).catch(() => {});
    process.exitCode = 1;
  }
  listener.close();
}

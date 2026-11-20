import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { windowsPreview } from "./delivery-preview.ts";
import type { DeliveryPreview } from "./types.ts";
import type { Files, StoredFile } from "./assets.ts";
import type { Params } from "./types.ts";
import { array, id, relativeFile } from "./validation.ts";

export type TaskAttachment = {source: string; file: StoredFile};
export const chunkBytes = 192 * 1024;
const lifetime = 3600_000;
type Upload = { projectId: string; name: string; size: number; offset: number; updated: number; busy: boolean; file?: StoredFile };

export class AttachmentUploads {
  private uploads = new Map<string, Upload>();
  private cleaned = 0;
  private clipboardImages=new Map<string,{path:string;at:number}>();
  rememberClipboardImages(paths:string[]) {
    const now=Date.now(),images:Record<string,string>={};
    for(const [ticket,f] of this.clipboardImages)if(now-f.at>24*lifetime)this.clipboardImages.delete(ticket);
    for(const path of paths)if(/\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|svg|ico)$/i.test(path)){
      const ticket=randomUUID();this.clipboardImages.set(ticket,{path,at:now});images[path]=ticket;
    }
    return images;
  }

  async clipboardImage(token:unknown,thumbnail:boolean):Promise<DeliveryPreview>{
    const item=this.clipboardImages.get(id(token));
    if(!item || Date.now()-item.at>24*lifetime)throw Error("此图片预览已过期，可重新粘贴。");
    const ext=extname(item.path).toLowerCase(),info=await stat(item.path);
    if(!info.isFile()||info.size>128*1024*1024)throw Error("图片过大，无法生成预览。");
    if(process.platform==="win32" && /^\.(png|jpe?g|gif|bmp|tiff?|ico)$/.test(ext))
      return windowsPreview(item.path,"raster",thumbnail);
    if(info.size>5*1024*1024)throw Error("图片过大，无法生成预览。");
    const mime:Record<string,string>={".svg":"image/svg+xml",".webp":"image/webp",".avif":"image/avif",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".bmp":"image/bmp",".ico":"image/x-icon"};
    if(!mime[ext])throw Error("当前环境无法预览此图片。");
    return {kind:"image",src:`data:${mime[ext]};base64,${(await readFile(item.path)).toString("base64")}`};
  }
  private directory: string;
  private files: Files;

  constructor(files: Files) { this.files = files; this.directory = join(files.root, "attachment-drafts"); }

  private async sweep() {
    const time = Date.now();
    if (time - this.cleaned < lifetime / 4) return;
    this.cleaned = time;
    for (const [key, item] of this.uploads) {
      if (!item.busy && time - item.updated > lifetime) this.uploads.delete(key);
    }
    for (const name of await readdir(this.directory)) {
      const chunk = /^[0-9a-f-]{36}\.part$/.test(name);
      const screenshot = /^clipboard-[0-9a-f-]{36}\.png$/.test(name);
      if ((!chunk && !screenshot) || (chunk && this.uploads.has(name.slice(0,-5)))) continue;
      const path = join(this.directory, name);
      const stamp = await stat(path).catch(() => null);
      if (stamp && time - stamp.mtimeMs > (screenshot ? 24*lifetime : lifetime)) await unlink(path).catch(() => {});
    }
  }

  async clipboardTarget() {
    await mkdir(this.directory, {recursive:true});
    await this.sweep();
    return join(this.directory, "clipboard-" + randomUUID() + ".png");
  }

  async begin(projectId: string, p: Params) {
    const name = relativeFile(p.name);
    if (name.includes("/") || !Number.isSafeInteger(p.size) || Number(p.size) < 0) throw Error("附件名称或大小无效。");
    await mkdir(this.directory, {recursive:true});
    await this.sweep();
    const token = randomUUID();
    this.uploads.set(token, { projectId, name, size:Number(p.size), offset:0, updated:Date.now(), busy:false });
    return {token};
  }

  private get(projectId: string, token: string) {
    const upload = this.uploads.get(token);
    if (!upload || upload.projectId !== projectId || Date.now()-upload.updated > lifetime) throw Error("附件上传已过期，请重新提交。");
    return upload;
  }

  async chunk(projectId: string, p: Params) {
    const token = id(p.token), item = this.get(projectId, token);
    if (item.busy || item.file || item.offset !== p.offset || typeof p.data !== "string" || p.data.length > Math.ceil(chunkBytes / 3) * 4)
      throw Error("附件分块顺序或大小无效，请重新提交。");
    const data = Buffer.from(p.data, "base64");
    if (data.toString("base64") !== p.data || data.length > chunkBytes || item.offset + data.length > item.size || (!data.length && item.size !== 0))
      throw Error("附件内容不完整，请重新提交。");
    const path = join(this.directory, token + ".part");
    item.busy = true;
    try {
      await appendFile(path, data, {flag:item.offset === 0 ? "wx" : "a", mode:0o600});
      item.offset += data.length;
      if (item.offset === item.size) {
        item.file = {...await this.files.ingest(path), fileName:item.name};
        await unlink(path);
      }
      item.updated = Date.now();
      return {received:item.offset};
    } catch (error) {
      this.uploads.delete(token);
      await unlink(path).catch(() => {});
      throw error;
    } finally { item.busy = false; }
  }

  async resolve(projectId: string, p: Params): Promise<TaskAttachment[]> {
    const uploads = array(p.uploads ?? [], "上传附件", 32);
    const paths = array(p.attachmentPaths ?? [], "路径附件", 32);
    if (uploads.length + paths.length > 32) throw Error("每次最多可添加 32 个附件。");
    const copies = uploads.map(token => {
      const item = this.get(projectId, id(token));
      if (!item.file || item.busy) throw Error("请等待附件上传完成。");
      return {source:"", file:item.file};
    });
    for (const selected of paths) {
      if (typeof selected !== "string") throw Error("附件路径无效。");
      const snapshot = dirname(selected) === this.directory && /^clipboard-[0-9a-f-]{36}\.png$/.test(basename(selected));
      try {
        const copy = await this.files.importFile(selected);
        copies.push(snapshot ? {source:"",file:{...copy.file,fileName:"粘贴截图.png"}} : copy);
      } catch (e) {
        if (snapshot && (e as NodeJS.ErrnoException).code==="ENOENT") throw Error("截图草稿已过期，请重新粘贴。");
        throw e;
      }
    }
    return copies;
  }
}

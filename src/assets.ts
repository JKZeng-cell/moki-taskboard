import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { array, localPath, object, relativeFile, text } from "./validation.ts";
import type { AssetVersion, Check, Snapshot } from "./types.ts";

export interface StoredFile {
  fileName: string;
  sha256: string;
  size: number;
}

export interface CollectedFile extends StoredFile {
  path: string;
  role: "output" | "handoff";
}

export interface Delivery {
  resumeSafe?:boolean;
  summary: string;
  checks: Check[];
  files: CollectedFile[];
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function inside(root: string, path: string) {
  const tail = relative(root, path);
  return Boolean(tail && tail !== ".." && !tail.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(tail));
}

export async function projectDirectory(value: unknown) {
  const root = await realpath(localPath(value));
  if (!(await stat(root)).isDirectory()) throw new Error("请选择项目目录。");
  return root;
}

async function outputPath(root: string, value: unknown) {
  const path = relativeFile(value);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`交付文件包含链接或目录联接：${path}`);
  }
  const canonical = await realpath(current);
  if (!inside(root, canonical)) throw new Error(`交付文件超出输出目录：${path}`);
  return canonical;
}

async function readText(path: string, max: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size > max) throw new Error(`文本文件无法读取或超过 ${max} 字节：${basename(path)}`);
  const data = await readFile(path);
  if (data.length > max) throw new Error("文本文件超过读取上限。");
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

export async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function publishBlob(staging: string, destination: string, sha256: string) {
  try {
    await link(staging, destination);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTSUP") throw error;
  }
  try {
    if (await digest(destination) !== sha256) throw new Error("已有托管文件的指纹异常。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Both paths are in the same directory. Concurrent publishers of this hash have identical bytes.
    try {
      await rename(staging, destination);
    } catch (renameError) {
      // Windows can reject replacement while a concurrent reader has the winning file open.
      if (await digest(destination).catch(() => null) !== sha256) throw renameError;
    }
  }
}

export class Files {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  blob(sha256: string) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("资产指纹无效。");
    return join(this.root, "blobs", sha256);
  }

  async ingest(path: string, output = false): Promise<StoredFile> {
    const info = await stat(path);
    if (!info.isFile() || (output && info.nlink > 1)) throw new Error("请选择可读取的独立文件。");
    const hash = createHash("sha256");
    const dir = join(this.root, "blobs");
    await mkdir(dir, { recursive: true });
    const staging = join(dir, `.${randomUUID()}.part`);
    try {
      await pipeline(createReadStream(path), new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        }
      }), createWriteStream(staging, { flags: "wx" }));
      const [after, copy] = await Promise.all([stat(path), stat(staging)]);
      if (after.ino !== info.ino || after.mtimeMs !== info.mtimeMs || copy.size !== info.size) {
        throw new Error("读取期间文件发生变化，请重试。");
      }
      const sha256 = hash.digest("hex");
      await publishBlob(staging, this.blob(sha256), sha256);
      return { fileName: basename(path), sha256, size: copy.size };
    } finally {
      await unlink(staging).catch(() => {});
    }
  }

  async importFile(value: unknown) {
    const source = await realpath(localPath(value));
    return { source, file: await this.ingest(source) };
  }

  async copyVersion(version: AssetVersion, destination: string) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(this.blob(version.sha256), destination);
    if (await digest(destination) !== version.sha256) throw new Error(`资产指纹异常：${version.fileName}`);
  }

  async preview(version: AssetVersion) {
    const name = relativeFile(version.fileName);
    if (name.includes("/")) throw new Error("资产文件名无效。");
    let target = join(this.root, "previews", version.id, name);
    try {
      if (await digest(target) === version.sha256) return target;
      target = join(this.root, "previews", version.id, randomUUID(), name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.copyVersion(version, target);
    return target;
  }

  async collect(workDir: string, snapshot: Snapshot, checkpoint=false, before=Infinity): Promise<Delivery> {
    const checks: Check[] = [];
    const files: CollectedFile[] = [];
    let summary = "";
    let resumeSafe=false;
    try {
      const output = join(await realpath(workDir), "outputs");
      if ((await lstat(output)).isSymbolicLink()) throw new Error("输出目录必须位于运行工作区内。");
      const root = await realpath(output);
      const manifestPath=await outputPath(root,checkpoint?"checkpoint.json":"delivery.json");
      if((await stat(manifestPath)).mtimeMs>=before)throw new Error("清单写于截止之后。");
      const manifest = object(JSON.parse(await readText(manifestPath,256*1024)));
      resumeSafe=checkpoint&&manifest.resumeSafe===true;
      summary = text(manifest.summary, "交付摘要", 4000);
      const entries = array(manifest.artifacts, "交付产物");
      if (!entries.length) throw new Error("交付清单至少须登记一项产物。");
      const seen = new Set<string>();
      const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
      for (const entry of entries) {
        const item = object(entry);
        const path = relativeFile(item.path);
        const role = item.role;
        const key = pathKey(path);
        if (key === "delivery.json" || key === "checkpoint.json" || seen.has(key) || (role !== "output" && role !== "handoff")) {
          throw new Error(`交付清单有重复路径或无效用途：${path}`);
        }
        seen.add(key);
        try {
          if (role === "handoff" && !/\.md$/i.test(path)) throw new Error("交接文件须为 Markdown。");
          const absolute=await outputPath(root,path);
          if((await stat(absolute)).mtimeMs>=before)throw new Error("文件写于截止之后。");
          const file = await this.ingest(absolute, true);
          if (!file.size) throw new Error("文件为空。");
          files.push({ ...file, path, role });
          checks.push({ label: `核对产物 ${path}`, passed: true, detail: `${file.size} 字节 · SHA-256 ${file.sha256}` });
        } catch (error) {
          checks.push({ label: `核对产物 ${path}`, passed: false, detail: errorText(error) });
        }
      }
      for (const required of checkpoint?[]:snapshot.expectedFiles) {
        const found = files.find(file => pathKey(file.path) === pathKey(required));
        checks.push({ label: `必交文件 ${required}`, passed: Boolean(found), detail: found ? found.sha256 : "交付清单中缺少可验证的文件。" });
      }
      for (const rule of checkpoint?[]:snapshot.textChecks) {
        const found = files.find(file => pathKey(file.path) === pathKey(rule.path));
        let passed = false;
        let detail = "交付文件缺少指定文本。";
        try {
          if (found) passed = (await readText(this.blob(found.sha256), 8 * 1024 * 1024)).includes(rule.contains);
          if (passed) detail = `已找到：${rule.contains}`;
        } catch (error) {
          detail = errorText(error);
        }
        checks.push({ label: `内容检查 ${rule.path}`, passed, detail });
      }
    } catch (error) {
      checks.push({ label: "交付清单", passed: false, detail: errorText(error) });
    }
    return { summary, checks, files, ...(checkpoint?{resumeSafe}: {}) };
  }
}

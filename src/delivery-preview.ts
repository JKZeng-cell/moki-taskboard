import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Files } from "./assets.ts";
import type { AssetVersion, DeliveryPreview } from "./types.ts";

const execute = promisify(execFile);
const maxImage = 3 * 1024 * 1024;
const textHead = 32 * 1024;
const raster: Record<string,string> = { ".png":"png", ".jpg":"jpeg", ".jpeg":"jpeg", ".gif":"gif", ".webp":"webp", ".svg":"svg+xml" };
const media:Record<string,string> = {".mp4":"video/mp4",".webm":"video/webm",".ogv":"video/ogg",".mp3":"audio/mpeg",".m4a":"audio/mp4",".ogg":"audio/ogg",".wav":"audio/wav",".flac":"audio/flac"};
const textFile = /\.(?:md|markdown|txt|log|csv|tsv|jsonl?|ya?ml|toml|ini|xml|html?|css|jsx?|tsx?|mjs|cjs|py|ps1|rs|go|java|sql|sh|diff|patch)$/i;

export async function windowsPreview(path:string, kind:string, thumbnail=false,page=1):Promise<DeliveryPreview> {
  const script=new URL("./render-delivery.ps1",import.meta.url);
  const {stdout}=await execute("powershell.exe",["-NoProfile","-NonInteractive","-File",
    fileURLToPath(script),"-Kind",kind,"-BlobPath",path,...(page!==1?["-Page",String(page)]:[]),...(thumbnail?["-Thumbnail"]:[])],{windowsHide:true,timeout:18000,maxBuffer:7*1024*1024,encoding:"utf8"});
  return JSON.parse(stdout.trim().replace(/^\uFEFF/,"")) as DeliveryPreview;
}

export async function deliveryPreview(files:Files, version:AssetVersion, thumbnailOnly=false):Promise<DeliveryPreview> {
  const path=files.blob(version.sha256), ext=extname(version.fileName).toLowerCase();
  const handle=await open(path,"r");
  try {
    const {size}=await handle.stat();
    if (size!==version.size) throw new Error("版本文件大小与登记记录不一致。");
    if (thumbnailOnly && process.platform==="win32" && size>64*1024 && size<=128*1024*1024 && /^\.(?:png|jpe?g|gif|bmp|tiff?)$/.test(ext)) {
      try { return await windowsPreview(path,"raster",true); } catch { /* Use the regular preview when the thumbnail codec is unavailable. */ }
    }
    const mime=raster[ext];
    const playable=media[ext] && size<=4*1024*1024 ? media[ext] : undefined;
    if (playable || (mime && size<=maxImage) || textFile.test(version.fileName)) {
      const length=mime || playable ? size : Math.min(size,textHead);
      const data=Buffer.alloc(length);
      let offset=0;
      while (offset<length) {
        const {bytesRead}=await handle.read(data,offset,length-offset,offset);
        if (!bytesRead) throw new Error("读取版本文件时内容不足。");
        offset+=bytesRead;
      }
      if (size===length && createHash("sha256").update(data).digest("hex")!==version.sha256) throw new Error("版本文件指纹与登记记录不一致。");
      if (playable) return {kind:playable.startsWith("video/")?"video":"audio",src:`data:${playable};base64,${data.toString("base64")}`};
      if (mime) return {kind:"image",src:`data:image/${mime};base64,${data.toString("base64")}`};
      const truncated=length<size;
      let body:string;
      try {body=new TextDecoder("utf-8",{fatal:true}).decode(data,{stream:truncated});}
      catch { return {kind:"native",reason:"此文件的文本编码需要使用原生预览。"}; }
      if (body.includes("\0")) return {kind:"native",reason:"此文件包含二进制内容。"};
      return {kind:/^\.m(?:d|arkdown)$/.test(ext)?"markdown":/^\.html?$/.test(ext)?"html":"text",text:body,truncated};
    }
    const thumbnail=[".png",".jpg",".jpeg",".gif",".bmp",".tif",".tiff"].includes(ext);
    const builtIn=thumbnail ? "raster" : [".pdf",".zip",".docx",".pptx",".xlsx"].includes(ext) ? ext.slice(1) : "";
    if (builtIn && process.platform==="win32" && size<=128*1024*1024) {
      try { return await windowsPreview(path,builtIn); }
      catch { return {kind:"native",reason:"此版本未能生成内嵌预览，可打开完整文件查看。"}; }
    }
    return {kind:"native",reason:"此格式或文件大小需要使用原生预览。"};
  } finally { await handle.close(); }
}

import {randomUUID} from "node:crypto";
import {open, realpath, stat, mkdtemp, writeFile, unlink, rmdir} from "node:fs/promises";
import {basename, extname, join} from "node:path";
import {tmpdir} from "node:os";
import {pipeline} from "node:stream/promises";
import {windowsPreview} from "../../src/delivery-preview.ts";

const mime={
  png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",avif:"image/avif",svg:"image/svg+xml",bmp:"image/bmp",ico:"image/x-icon",
  mp4:"video/mp4",webm:"video/webm",ogv:"video/ogg",mov:"video/quicktime",mp3:"audio/mpeg",m4a:"audio/mp4",ogg:"audio/ogg",wav:"audio/wav",flac:"audio/flac"
};
const officeTypes=["doc","docx","xls","xlsx","ppt","pptx"];
const pageSize=128*1024;
const version=s=>s.dev+":"+s.ino+":"+s.size+":"+s.mtimeMs;

export class PreviewFiles {
  byPath=new Map();
  tickets=new Map();

  async issue(path) {
    const canonical=await realpath(path);
    const info=await stat(canonical);
    if(!info.isFile())throw Error("只能预览文件。");
    const previous=this.byPath.get(canonical);
    if(previous && previous.version===version(info))return previous.ticket;
    const entry={ticket:randomUUID(),path:canonical,name:basename(path),version:version(info)};
    if(previous)this.tickets.delete(previous.ticket);
    this.tickets.set(entry.ticket,entry);
    this.byPath.set(canonical,entry);
    return entry.ticket;
  }

  async file(ticket) {
    const entry=this.tickets.get(ticket);
    if(!entry || await realpath(entry.path)!==entry.path)throw Error("文件预览已失效，请从任务台重新打开。");
    const handle=await open(entry.path,"r");
    try{
      const info=await handle.stat();
      if(!info.isFile() || version(info)!==entry.version)throw Error("文件已更新，请从任务台重新打开。");
      return {...entry,handle,size:info.size,ext:extname(entry.name).slice(1).toLowerCase()};
    }catch(error){await handle.close();throw error;}
  }
}

async function officePage(file,service,page,signal) {
  if(!service) {
    if(["docx","pptx","xlsx"].includes(file.ext))return windowsPreview(file.path,file.ext);
    return {kind:"native",reason:"当前 DSH 未提供此文档的转换服务。"};
  }
  const converted=await service.convert({extension:file.ext,priority:"foreground",source:{
    key:file.path,version:file.version,bytes:file.size,read:async(upstream,maxBytes)=>{
      upstream.throwIfAborted();
      if(file.size>maxBytes)throw Error("文档超出 DSH 转换服务容量。");
      const bytes=await file.handle.readFile({signal:upstream});
      if(bytes.length!==file.size || version(await file.handle.stat())!==file.version)throw Error("文档已更改，请重新打开。");
      return {bytes,version:file.version};
    }
  }},signal);
  const temp=await mkdtemp(join(tmpdir(),"moki-workspace-"));
  const target=join(temp,"preview.pdf");
  try{await writeFile(target,converted.pdf,{signal});return await windowsPreview(target,"pdf",false,page);}
  finally{await unlink(target).catch(()=>{});await rmdir(temp).catch(()=>{});}
}

export async function describePreview(files,ticket,page,office,signal) {
  if(!Number.isSafeInteger(page)||page<1)throw Error("页码无效。");
  const f=await files.file(ticket);
  try{
    const type=mime[f.ext];
    if(type)return {name:f.name,pages:1,value:{kind:type.split("/")[0],src:"./media/"+f.ticket}};
    const officeFile=officeTypes.includes(f.ext);
    if(officeFile || ["pdf","zip","tif","tiff"].includes(f.ext)){
      const kind=f.ext==="tif"||f.ext==="tiff"?"raster":f.ext;
      const value=officeFile?await officePage(f,office,page,signal):await windowsPreview(f.path,kind,false,page);
      return {name:f.name,pages:Number(value.label?.split("/")[1])||1,value};
    }
    const pages=Math.max(1,Math.ceil(f.size/pageSize));
    if(page>pages)throw Error("页码超出文件范围。");
    const start=(page-1)*pageSize;
    const data=Buffer.alloc(Math.min(f.size-start,pageSize+3));
    const {bytesRead}=await f.handle.read(data,0,data.length,start);
    let head=0,end=Math.min(bytesRead,pageSize);
    while(head<bytesRead && (data[head]&0xc0)===0x80)head++;
    while(end<bytesRead && (data[end]&0xc0)===0x80)end++;
    try{
      const text=new TextDecoder("utf-8",{fatal:true}).decode(data.subarray(head,end));
      if(text.includes("\0"))throw Error();
      const kind=/^(md|markdown)$/.test(f.ext)?"markdown":/^html?$/.test(f.ext)?"html":"text";
      return {name:f.name,pages,value:{kind,text,truncated:false}};
    }catch{return {name:f.name,pages:1,value:{kind:"native",reason:"此工作区暂时无法显示该文件的格式或编码。"}};}
  }finally{await f.handle.close();}
}

export async function streamPreview(files,ticket,req,res) {
  const f=await files.file(ticket);
  try{
    const type=mime[f.ext];
    if(!type)throw Error("此文件不支持流式预览。");
    const headers={"Content-Type":type,"Content-Security-Policy":"sandbox; default-src 'none'","X-Content-Type-Options":"nosniff",
      "Referrer-Policy":"no-referrer","Cache-Control":"no-store","Accept-Ranges":"bytes"};
    let start=0,end=f.size-1,status=200;
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(match?.[1]){start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      else if(match?.[2])start=Math.max(0,f.size-Number(match[2]));
      if(!match || !(match[1]||match[2]) || !Number.isSafeInteger(start) || start>end || start<0){
        res.writeHead(416,{...headers,"Content-Range":"bytes */"+f.size});res.end();return;
      }
      status=206;headers["Content-Range"]="bytes "+start+"-"+end+"/"+f.size;
    }
    res.writeHead(status,{...headers,"Content-Length":end-start+1});
    if(req.method==="HEAD" || !f.size)res.end();
    else await pipeline(f.handle.createReadStream({start,end}),res);
  }finally{await f.handle.close();}
}

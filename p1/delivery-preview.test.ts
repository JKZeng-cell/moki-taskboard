import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Files } from "../src/assets.ts";
import { deliveryPreview } from "../src/delivery-preview.ts";
import { Store } from "../src/store.ts";

test("验收预览固定版本内容，限制读取量并校验实际文件",async t=>{
  const root=await mkdtemp(join(tmpdir(),"moki-proof-")),store=new Store(root),files=new Files(root);
  t.after(async()=>{store.db.close(); await rm(root,{recursive:true,force:true});});
  const pid=store.saveProject({title:"预览"},root).id, path=join(root,"过程.md");
  async function save(body:string) {
    await writeFile(path,body);
    const [{versionId}]=store.importFiles(pid,[await files.importFile(path)]);
    return store.version(pid,versionId);
  }
  const v1=await save("# 一期交付\n原始内容"),v2=await save("# 二期交付\n"+"成果".repeat(18000));
  assert.deepEqual(await deliveryPreview(files,v1),{kind:"markdown",text:"# 一期交付\n原始内容",truncated:false});
  const second=await deliveryPreview(files,v2);
  assert.ok(second.kind==="markdown" && second.truncated && second.text.startsWith("# 二期交付") && !second.text.includes("\uFFFD"));
  const other=store.saveProject({title:"另一项目"},join(root,"other")).id;
  assert.throws(()=>store.version(other,v1.id));
  await writeFile(files.blob(v1.sha256),Buffer.alloc(v1.size));
  await assert.rejects(deliveryPreview(files,v1),/指纹/);
  await assert.rejects(deliveryPreview(files,{...v2,size:1}),/大小/);
});

test("Windows 图片缩略图维持宽高比，放大使用独立的较高分辨率", {skip:process.platform!=="win32"}, async t=>{
  const root=await mkdtemp(join(tmpdir(),"moki-thumb-")),store=new Store(root),files=new Files(root);
  t.after(async()=>{store.db.close();await rm(root,{recursive:true,force:true});});
  const width=320,height=240,buf=Buffer.alloc(54+width*height*3,128);
  buf.fill(0,0,54); buf.write("BM");buf.writeUInt32LE(buf.length,2);buf.writeUInt32LE(54,10);
  buf.writeUInt32LE(40,14);buf.writeUInt32LE(width,18);buf.writeUInt32LE(height,22);buf.writeUInt16LE(1,26);buf.writeUInt16LE(24,28);
  const path=join(root,"photo.bmp");await writeFile(path,buf);
  const pid=store.saveProject({title:"图片"},root).id;
  const [{versionId}]=store.importFiles(pid,[await files.importFile(path)]);
  const version=store.version(pid,versionId);
  for(const [thumb,w,h] of [[true,240,180],[false,320,240]] as const) {
    const image=await deliveryPreview(files,version,thumb);assert.equal(image.kind,"image");
    const png=Buffer.from(image.src.split(",")[1],"base64");
    assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[w,h]);
  }
});


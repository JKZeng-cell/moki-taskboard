import { msg } from "./i18n.ts";
import { fileExtension } from "../grouping.ts";

const types = {
  pdf: ["PDF 文档", "M5 17c6-4 7-9 5-12-2 2 1 7 3 9s5 3 6 2c1-2-4-3-8-1s-6 4-6 2Z", "#a53430", "#ffaca7", "pdf"],
  word: ["文字文档", "M4 6l2.4 12L10 9l3.4 9L16 6m1 4h3m-4 4h4", "#3159ab", "#a8c3ff", "doc docx docm odt rtf pages"],
  sheet: ["电子表格", "M3 5h18v14H3Zm0 5h18m-12 0v9m5-9v9M3 14h18", "#176b49", "#82d5af", "xls xlsx xlsm ods csv tsv numbers"],
  slides: ["演示文稿", "M3 4h18v13H3Zm9 13v4m-5 0 5-4 5 4M7 12l3-3 3 2 4-4", "#985117", "#ffc695", "ppt pptx pptm odp key"],
  markdown: ["Markdown 文档", "M2 6h20v13H2Zm3 9V9l3 3 3-3v6m5-6v6m-2-2 2 2 2-2", "#564498", "#c6b6ff", "md mdx markdown"],
  image: ["图像", "M3 4h18v16H3Zm1 13 5-5 3 3 4-5 5 6M7 8h.1", "#186b82", "#85d6ec", "png jpg jpeg webp avif gif svg bmp tif tiff heic ico"],
  audio: ["音频", "M9 17V6l10-2v11M9 9l10-2M9 17c0 3-6 4-6 1s6-4 6-1Zm10-2c0 3-6 4-6 1s6-4 6-1Z", "#94406e", "#f4afd2", "mp3 wav aac flac ogg m4a opus aiff"],
  video: ["视频", "M3 5h18v14H3Zm6 3 6 4-6 4Z", "#70429e", "#d5b0fa", "mp4 mov mkv avi webm m4v mpg mpeg"],
  archive: ["压缩包", "M4 5h16v4H4Zm1 4h14v11H5Zm6 0v2h2v2h-2v2h2m-3 2h4", "#806022", "#eac985", "zip 7z rar tar gz bz2 xz zst tgz"],
  code: ["源代码", "m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-3 18", "#126c76", "#83d9d7", "js jsx ts tsx py html htm css scss less java cs cpp c h hpp rs go swift vue svelte sh ps1 bat sql rb php kotlin kt"],
  data: ["数据文件", "M9 4H7v5q0 3-3 3 3 0 3 3v5h2m6-16h2v5q0 3 3 3-3 0-3 3v5h-2", "#805321", "#f5c691", "json jsonl yaml yml toml xml ini env db sqlite sqlite3 parquet"],
  design: ["设计文件", "m4 20 3-9 10-8 4 4-8 10-9 3Zm3-9 6 6m-9 3 6-6", "#954578", "#e9aad8", "psd ai fig sketch xd blend aep prproj"],
  text: ["文本", "M5 3h10l4 4v14H5Zm9 0v5h5M8 12h8m-8 4h5", "#4f616f", "#b6cad9", "txt log rst"],
  file: ["文件", "M5 3h9l5 5v13H5Zm9 0v6h5", "#586068", "#b6bec7", ""]
} as const;
type Kind = keyof typeof types;
const extensions = new Map<string,Kind>();
for (const k of Object.keys(types) as Kind[]) for (const ext of types[k][4].split(" ")) if (ext) extensions.set(ext,k);

export function fileKind(name: string): Kind {
  const base = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (base === ".env" || base.startsWith(".env.")) return "data";
  if (["dockerfile","makefile","jenkinsfile"].includes(base)) return "code";
  return extensions.get(fileExtension(base).toLowerCase()) ?? "file";
}

export function FileIcon({name, size=17, tile=false}: {name:string; size?:number; tile?:boolean}) {
  const kind = fileKind(name), [label, path, light, dark] = types[kind];
  const ext = fileExtension(name.split(/[\\/]/).at(-1) ?? name);
  const title = ext ? `${ext} · ${msg(label)}` : msg(label);
  return <span className={tile ? "type-icon tile" : "type-icon"} data-file-kind={kind} role="img" aria-label={title}
    title={title} style={{color:`light-dark(${light}, ${dark})`}}>
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>
  </span>;
}


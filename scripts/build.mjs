import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const dsh = process.argv.includes("--dsh");
const dist = fileURLToPath(new URL(dsh ? "../ports/dsh/dist/" : "../plugins/moki-taskboard/dist/", import.meta.url));
const edition = dsh ? JSON.parse(await readFile(new URL("../ports/dsh/package.json", import.meta.url), "utf8")) : undefined;
const platform = { "__MOKI_DSH__": JSON.stringify(dsh), ...(edition ? { "__MOKI_DSH_VERSION__": JSON.stringify(edition.version) } : {}) };
await mkdir(dist, { recursive: true });
const [ui, css, frame] = await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: ["src/ui/main.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome124",
    write: false,
    minify: true,
    legalComments: "inline",
    define: { ...platform, "process.env.NODE_ENV": '"production"' }
  }),
  readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/ui/index.html", import.meta.url), "utf8")
]);
const script = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: dsh ? ["ports/dsh/host.mjs"] : ["src/mcp.ts", "src/service.ts"],
    define: { ...platform, __MOKI_PICKER_SCRIPT__: JSON.stringify(await readFile(new URL("./pick-path.ps1", import.meta.url), "utf8")) },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    outdir: dist
  }),
  writeFile(dist + "panel.html",
    frame.replace("/* STYLES */", () => css).replace("/* SCRIPT */", () => script)),
  copyFile(new URL("../src/render-delivery.ps1", import.meta.url), dist + "render-delivery.ps1"),
  copyFile(new URL("../scripts/pick-path.ps1", import.meta.url),
    dist + "pick-path.ps1")
]);
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (dsh) await copyFile(new URL("../plugins/moki-taskboard/assets/taskboard.svg",import.meta.url),new URL("../ports/dsh/icon.svg",import.meta.url));
console.log(`Built MOKI Taskboard ${edition?.version ?? pkg.version} for ${dsh ? "DSH" : "Codex"}`);

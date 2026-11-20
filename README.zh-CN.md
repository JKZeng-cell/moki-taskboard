# MOKI任务台 for Codex

[English](README.md) · [简体中文](README.zh-CN.md) · [Releases](https://github.com/JKZeng-cell/moki-taskboard/releases)

**Windows · Codex plugin v0.2.23 · MIT**

同一项工作常常散在几段对话里。MOKI 把任务说明、所用附件、执行会话和交付物放在一张卡上。以制作一本春季徒步手册为例，可以先把路线翻译排进队列，给地图绘制附上草图，再打开校对任务逐项验收。

| 工作环节 | 可以怎么用 |
| --- | --- |
| 拆任务 | 在看板上分列管理待办、队列、进行中、待验收、完成、暂停和错误。也可以切到表格。 |
| 启动 Agent | 立即执行、按队列运行，或限定到每周时段。可自动匹配会话、指定项目内已有会话，或新开会话。 |
| 准备资料 | 将文件或截图拖入任务，执行时固定输入版本。之后更新原文件，仍可查到当时使用的版本。 |
| 验收与返工 | 在任务里预览交付物，检查必交文件；需要调整时点「继续优化」，带上新意见和附件，再比较两轮交付。 |
| 找回项目进展 | 可按授权范围关联会话，从状态判定跳回原话；用日、周、月活动视图查看有变化的任务。 |

项目库和托管文件保存在本机。启动 Agent 或启用语义归集时，相关任务内容会由所选宿主和模型处理，并使用该账号的模型额度。

![任务看板 / Codex](media/board.png)

## 看图了解任务台

一条“做北线补水卡”的编辑需求，经会话归集自动进入春季刊项目。也可以在底部快捷框写说明、拖入附件，再按 Ctrl+Enter 建卡。

[查看五个功能页、两条操作流程和 DSH 预览](media/launch/tour/README.md) · [下载九图素材](https://github.com/JKZeng-cell/moki-taskboard/releases/download/v0.2.23/moki-taskboard-gallery-zh.zip)

[![MOKI Taskboard · Feature tour](media/launch/tour/preview.jpg)](media/launch/tour/README.md)

## 安装

使用 Windows Codex 桌面、支持插件命令的 Codex CLI 和 Node.js 24 或更高版本。确保桌面进程能在 PATH 中找到 node；首次安装 Node 后重启桌面应用。

```powershell
codex plugin marketplace add JKZeng-cell/moki-taskboard
codex plugin add moki-taskboard@moki-plugins
```
在插件目录选择 MOKI Plugins，打开「MOKI任务台 for Codex」。先建一个项目，选择工作目录，再添加第一张任务卡。也可下载 Release 的 ZIP，解压后用解压目录替代第一条命令中的仓库名。

## 从源码构建

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run build:dsh
node --experimental-strip-types --test ports/dsh/adapter.test.mjs
```

[DSH 版与安装包](https://github.com/JKZeng-cell/moki-taskboard-for-dsh)

[项目配图与文案 · Launch media kit](https://github.com/JKZeng-cell/moki-taskboard/tree/main/media/launch)

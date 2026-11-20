import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Files } from "../src/assets.ts";
import { Store } from "../src/store.ts";
import { chooseModel, listModels } from "../src/models.ts";
import { AppServer } from "../src/app-server.ts";
import { Runner } from "../src/runner.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { RunRecord } from "../src/types.ts";
import { taskStatuses } from "../src/workflow.ts";
import { groupsBy, fileType } from "../src/grouping.ts";
import { summarizeUsage } from "../src/usage.ts";

// The migration fixtures below reconstruct the actual columns of the older schemas.
function restoreV5Schema(store:Store) {
  store.db.exec(`DROP TABLE conversation_updates; DROP TABLE project_releases;
    DROP TRIGGER activity_create; DROP TRIGGER activity_status; DROP TABLE task_activity;
    DROP TABLE conversation_files; DROP TABLE conversation_owned_assets;
    DROP TABLE semantic_receipts; DROP TABLE semantic_jobs; DROP TABLE thread_match_evidence;
    ALTER TABLE capture_items DROP COLUMN evidence;
    ALTER TABLE thread_links DROP COLUMN matchBasis; ALTER TABLE thread_links DROP COLUMN matchReason;
    ALTER TABLE project_policy DROP COLUMN semanticScope; ALTER TABLE panel_settings DROP COLUMN assetView;
    DROP TRIGGER project_layout_insert; DROP TRIGGER project_layout_update;
    DROP TABLE run_checkpoints; DROP TABLE capture_refs; DROP TABLE capture_items; DROP TABLE capture_cursors; DROP TABLE thread_links;
    DROP TABLE asset_edits; DROP TABLE run_approvals; DROP TABLE project_policy; DROP TABLE project_groups;
    ALTER TABLE projects DROP COLUMN sortOrder; ALTER TABLE panel_settings DROP COLUMN layoutVersion;
    ALTER TABLE runs DROP COLUMN deadline; ALTER TABLE runs DROP COLUMN stopAt; ALTER TABLE runs DROP COLUMN stopReason;
    ALTER TABLE runs DROP COLUMN parentRunId; PRAGMA user_version=5;`);
}
function restoreV3Schema(store: Store) {
  restoreV5Schema(store);
  store.db.exec(`
    DROP TABLE task_reviews;
    ALTER TABLE projects DROP COLUMN category;
    ALTER TABLE assets DROP COLUMN groupName;
    ALTER TABLE runs DROP COLUMN totalTokens;
    ALTER TABLE runs DROP COLUMN inputTokens;
    ALTER TABLE runs DROP COLUMN outputTokens;
    ALTER TABLE runs DROP COLUMN turnDurationMs;
    PRAGMA user_version=3;
  `);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "moki-taskboard-test-"));
  const root = join(dir, "workspace");
  await mkdir(root);
  const store = new Store(dir);
  return {
    root, store, files: new Files(dir),
    async close() { store.db.close(); await rm(dir, { recursive: true, force: true }); }
  };
}

async function deliver(run: RunRecord, artifacts: { path: string; role: string }[], bodies: Record<string, string>) {
  const outputs = join(run.workDir, "outputs");
  await mkdir(outputs, { recursive: true });
  for (const [name, body] of Object.entries(bodies)) await writeFile(join(outputs, name), body, "utf8");
  await writeFile(join(outputs, "delivery.json"), JSON.stringify({ summary: "交付已写入", artifacts }), "utf8");
}

test("v3 升级保留历史耗时，分类和资料组跨重启保存，旧调用与版本冲突不覆盖分组", async () => {
  const { root, store, files, close } = await fixture();
  try {
    const project = store.saveProject({ title: "原有项目" }, root);
    const task = store.quickCreate({ projectId: project.id, instructions: "原有任务", timing: "now", requestKey: randomUUID() });
    store.finish(task.runId!, "completed", { files: [], checks: [], summary: "" });
    const path = join(root, "样本.MD");
    await writeFile(path, "保留内容", "utf8");
    const [asset] = store.importFiles(project.id, [await files.importFile(path)]);
    restoreV3Schema(store);
    const upgraded = new Store(store.root);
    try {
      const old = upgraded.state(project.id);
      assert.equal(old.project?.category, "");
      assert.equal(old.assets[0].groupName, "");
      assert.equal(old.assets[0].versions[0].id, asset.versionId);
      assert.equal(old.runs[0].totalTokens, null);
      assert.equal(summarizeUsage(old.runs).estimated, 1);
      const edit = { id: project.id, title: "原有项目", version: 1 };
      upgraded.saveProject({ ...edit, category: "  设计  " }, root);
      assert.throws(() => upgraded.saveProject({ ...edit, category: "其他" }, root), /已有更新/);
      upgraded.saveProject({ ...edit, version: 2 }, root);
      const values = { id: asset.id, name: "改名后无后缀", context: true, version: 1 };
      upgraded.saveAsset({ ...values, groupName: "参考" });
      assert.throws(() => upgraded.saveAsset({ ...values, groupName: "其他" }), /已有更新/);
      upgraded.saveAsset({ ...values, version: 2 });
    } finally { upgraded.db.close(); }
    const reopened = new Store(store.root);
    try {
      const state = reopened.state(project.id);
      assert.equal(state.project!.category, "设计");
      assert.equal(state.assets[0].groupName, "参考");
      assert.equal(fileType(state.assets[0].versions[0].fileName), "MD 文件");
      reopened.saveProject({ id: project.id, title: "原有项目", version: 3, category: "" }, root);
      reopened.saveAsset({ id: asset.id, name: "改名", context: true, version: 3, groupName: "" });
      assert.equal(reopened.state(project.id).assets[0].groupName, "");
      assert.equal(reopened.project(project.id).category, "");
    } finally { reopened.db.close(); }
  } finally { await close(); }
});

test("按次累计用量，处理回执重放、错序、重试、缺报、运行中和待核对", async () => {
  const { root, store, close } = await fixture();
  try {
    const project = store.saveProject({ title: "统计" }, root);
    const task = store.saveTask({ projectId: project.id, title: "多次尝试", instructions: "验证" });
    const claim = () => store.claim({ id: task.id, version: store.taskRow(task.id).version, requestKey: randomUUID() }, false).id;
    const run = claim();
    const thread = randomUUID(), turn = randomUUID();
    store.progress(run, "进行中", thread, turn);
    const report = (inputTokens: number, outputTokens: number) => ({ total: { totalTokens: inputTokens + outputTokens, inputTokens, outputTokens } });
    store.recordUsage(run, thread, randomUUID(), report(500, 1));
    store.recordUsage(run, randomUUID(), turn, report(500, 1));
    store.recordUsage(run, thread, turn, report(-5, 20));
    assert.equal(store.run(run).totalTokens, null);
    for (const input of [5, 10, 10, 5]) store.recordUsage(run, thread, turn, report(input, 4));
    const finish = { files: [], checks: [], summary: "" };
    store.finish(run, "failed", finish, "", 1200);
    const retry = claim();
    store.progress(retry, "进行中", thread, randomUUID());
    const began = Date.parse(store.run(retry).startedAt);
    let stats = summarizeUsage(store.state(project.id).runs, began + 2500);
    assert.deepEqual(stats, { count: 2, reported: 1, tokens: 14, input: 10, output: 4, timed: 2, estimated: 1, elapsed: 3700 });
    store.recover(retry, "断连");
    assert.equal(summarizeUsage(store.state(project.id).runs, began + 900000).elapsed, 1200);
    store.finish(retry, "interrupted", finish, "", 3000);
    const other = store.quickCreate({ projectId: project.id, instructions: "另一任务", timing: "now", requestKey: randomUUID() });
    store.progress(other.runId!, "进行中", thread, turn);
    store.recordUsage(other.runId!, thread, turn, report(0, 0));
    store.finish(other.runId!, "completed", finish, "", 5000);
    const state = store.state(project.id);
    stats = summarizeUsage(state.runs);
    assert.equal(stats.elapsed, 9200);
    assert.equal(stats.reported, 2);
    assert.equal(stats.tokens, 14);
    const byTask = summarizeUsage(state.runs.filter(item => item.taskId === task.id));
    assert.equal(byTask.count, 2);
    assert.equal(byTask.elapsed, 4200);
    const empty = store.saveProject({ title: "隔离项目" }, root);
    assert.equal(summarizeUsage(store.state(empty.id).runs).count, 0);
  } finally { await close(); }
});

test("文件分组支持大小写、无扩展名、复合文件名和用户自定义组名", () => {
  assert.deepEqual(["A.PnG", "b.png", ".env", "README", "a.tar.gz", "a."].map(fileType),
    ["PNG 文件", "PNG 文件", "无扩展名", "无扩展名", "GZ 文件", "无扩展名"]);
  const groups = new Map(groupsBy(["", "__proto__", "未分组", "__proto__"], name => name));
  assert.deepEqual(groups.get("__proto__"), ["__proto__", "__proto__"]);
  assert.equal(groups.size, 3);
});

test("同时导入相同内容复用完整托管副本，已有文件哈希异常时保留现场", async () => {
  const { root, files, close } = await fixture();
  try {
    const source = join(root, "分组样本.txt");
    await writeFile(source, "同一份资料");
    const imports = await Promise.all(Array.from({ length: 4 }, () => files.importFile(source)));
    const hash = imports[0].file.sha256;
    assert.ok(imports.every(item => item.file.sha256 === hash));
    await writeFile(files.blob(hash), "损坏的测试副本");
    await assert.rejects(files.importFile(source), /指纹异常/);
  } finally { await close(); }
});

test("派发链路按 thread 与 turn 接收累计通知，并保存终态回合时长", async t => {
  const { root, store, files, close } = await fixture();
  try {
    const project = store.saveProject({ title: "派发测试" }, root);
    const task = store.quickCreate({ projectId: project.id, instructions: "统计回读", timing: "now", requestKey: randomUUID() });
    const run = store.run(task.runId!);
    const threadId = randomUUID(), turnId = randomUUID();
    const rpc = {
      onNotification: (_message: { method: string; params: Record<string, unknown> }) => {},
      async initialize() { return {}; },
      close() {},
      async call(method: string) {
        switch (method) {
          case "command/exec":
            await writeFile(join(run.workDir, ".moki-write-check"), "taskboard");
            return { exitCode: 0 };
          case "model/list": return { data: [{ model: "fixture", isDefault: true }] };
          case "thread/start": return { thread: { id: threadId } };
          case "thread/name/set": return {};
          case "turn/start": {
            const receipt = { threadId, turnId, tokenUsage: { total: { totalTokens: 120, inputTokens: 100, outputTokens: 20 } } };
            this.onNotification({ method: "thread/tokenUsage/updated", params: receipt });
            this.onNotification({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
            assert.equal(store.run(run.id).totalTokens, 120);
            const final = { ...receipt, tokenUsage: { total: { totalTokens: 180, inputTokens: 150, outputTokens: 30 } } };
            this.onNotification({ method: "thread/tokenUsage/updated", params: { ...final, threadId: randomUUID() } });
            assert.equal(store.run(run.id).totalTokens, 120);
            this.onNotification({ method: "thread/tokenUsage/updated", params: final });
            await deliver(run, [{ path: "统计.md", role: "output" }], { "统计.md": "样本" });
            this.onNotification({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", durationMs: 3250 } } });
            return { turn: { id: turnId } };
          }
          default: throw new Error(method);
        }
      }
    };
    t.mock.method(AppServer, "open", async () => rpc);
    const runner = new Runner(store, files);
    runner.start(run.id);
    const deadline = Date.now() + 6000;
    while (runner.isActive(run.id) && Date.now() < deadline) await delay(10);
    const saved = store.run(run.id);
    assert.equal(saved.status, "review", saved.error);
    assert.equal(saved.totalTokens, 180);
    assert.equal(saved.turnDurationMs, 3250);
  } finally { await close(); }
});

test("快捷创建可重试，立即执行原子领取，忙碌时保留其他项目与待办", async () => {
  const { root, store, close } = await fixture();
  try {
    const project = store.saveProject({ title: "甲", preferredModel: "chosen", preferredEffort: "high" }, root);
    const other = store.saveProject({ title: "乙" }, root);
    const todo = { projectId: project.id, instructions: "快捷标题\n完整执行说明", timing: "todo", requestKey: randomUUID() };
    const task = store.quickCreate(todo);
    assert.equal(store.taskRow(task.taskId).title, "快捷标题");
    assert.equal(store.taskRow(task.taskId).instructions, todo.instructions);
    assert.equal(store.taskRow(task.taskId).status, "todo");
    assert.equal(task.runId, null);
    assert.equal(store.quickCreate(todo).taskId, task.taskId);
    assert.throws(() => store.quickCreate({ ...todo, timing: "now" }), /标识已使用/);
    const immediate = { ...todo, timing: "now", requestKey: randomUUID() };
    const run = store.quickCreate(immediate);
    assert.equal(store.quickCreate(immediate).created, false);
    assert.equal(store.quickCreate(immediate).runId, run.runId);
    assert.equal(store.taskRow(run.taskId).status, "running");
    store.saveProject({ ...project, version: 1, title: "甲", preferredEffort: "low" }, root);
    assert.equal(store.project(project.id).preferredModel, "chosen");
    assert.equal(store.run(run.runId!).snapshot.preferredEffort, "high");
    const blocked = { ...immediate, projectId: other.id, requestKey: randomUUID() };
    assert.throws(() => store.quickCreate(blocked), /同一目录/);
    assert.equal(store.state(other.id).tasks.length, 0);
    assert.ok(store.quickCreate({ ...blocked, timing: "todo" }).created);
    const size = store.state(project.id).tasks.length;
    assert.throws(() => store.quickCreate({ ...todo, instructions: "  ", requestKey: randomUUID() }), /任务说明/);
    assert.equal(store.state(project.id).tasks.length, size);
  } finally { await close(); }
});

test("新建表单立即执行固定全部字段和附件，重复提交只产生一轮执行", async () => {
  const { root, store, files, close } = await fixture();
  try {
    const {id: projectId} = store.saveProject({title:"表单启动"}, root);
    const path = join(root, "参考.md");
    await writeFile(path, "输入资料");
    const [asset] = store.importFiles(projectId, [await files.importFile(path)]);
    const attachment = join(root, "补充.md");
    await writeFile(attachment, "表单附件");
    const copies = [await files.importFile(attachment)];
    const params = { projectId, requestKey:randomUUID(), timing:"now", sessionChoice:{mode:"new"},
      title:"明确指定的标题", instructions:"任务说明首行", expectedFiles:["交付.md"],
      textChecks:[{path:"交付.md",contains:"通过"}], reviewCriteria:"人工复核",
      inputVersionIds:[asset.versionId] };
    const result = store.quickCreate(params,copies);
    const snapshot = store.run(result.runId!).snapshot;
    assert.equal(store.taskRow(result.taskId).title,params.title);
    assert.equal(snapshot.instructions,params.instructions);
    assert.deepEqual(snapshot.sessionChoice,params.sessionChoice);
    assert.deepEqual(snapshot.expectedFiles,params.expectedFiles);
    assert.deepEqual(snapshot.textChecks,params.textChecks);
    assert.equal(snapshot.reviewCriteria,params.reviewCriteria);
    assert.ok(snapshot.files.some(file => file.id === asset.versionId));
    assert.equal(snapshot.files.length,2);
    assert.deepEqual(store.quickCreate(params,copies),{...result,created:false});
    assert.throws(() => store.quickCreate({...params,reviewCriteria:"不同要求"},copies), /标识已使用/);
    assert.throws(() => store.quickCreate({...params,requestKey:randomUUID()},copies), /已有执行/);
    const board = store.state(projectId);
    assert.equal(board.tasks.length,1);
    assert.equal(board.runs.length,1);
    assert.equal(board.assets.length,2);
  } finally { await close(); }
});

test("从上一版升级保留项目、历史任务与模型默认值，输入框状态可重启恢复", async () => {
  const { root, store, close } = await fixture();
  try {
    const project = store.saveProject({ title: "原有项目" }, root);
    const task = store.saveTask({ projectId: project.id, title: "原有任务", instructions: "保留" });
    const run = store.claim({ id: task.id, version: 1, requestKey: randomUUID() }, false);
    restoreV3Schema(store);
    store.db.exec(`
      DROP TABLE quick_requests; DROP TABLE panel_settings;
      ALTER TABLE projects DROP COLUMN preferredModel; ALTER TABLE projects DROP COLUMN preferredEffort;
      ALTER TABLE runs DROP COLUMN effectiveModel; ALTER TABLE runs DROP COLUMN effectiveEffort;
      UPDATE runs SET snapshot=json_remove(snapshot,'$.preferredEffort','$.preferredModel');
      PRAGMA user_version=1;
    `);
    const migrated = new Store(store.root);
    try {
      assert.equal(migrated.project(project.id).preferredModel, null);
      assert.equal(migrated.taskRow(task.id).instructions, "保留");
      assert.equal(migrated.run(run.id).effectiveEffort, null);
      assert.equal(migrated.state().composerMinimized, false);
      migrated.setComposerMinimized(true);
    } finally { migrated.db.close(); }
    const reopened = new Store(store.root);
    try { assert.equal(reopened.state().composerMinimized, true); } finally { reopened.db.close(); }
  } finally { await close(); }
});

test("旧面板升级后默认展开侧栏，独立保存侧栏和输入框状态", async () => {
  const { root, store, close } = await fixture();
  try {
    const project = store.saveProject({ title: "保留的项目" }, root);
    store.setComposerMinimized(true);
    restoreV3Schema(store);
    store.db.exec("ALTER TABLE panel_settings DROP COLUMN sidebarCollapsed; PRAGMA user_version=2;");
    const upgraded = new Store(store.root);
    try {
      assert.equal(upgraded.state().assetView, "list");
      assert.throws(() => upgraded.setAssetView("grid"), /资产视图无效/);
      upgraded.setAssetView("cards");
      assert.equal(upgraded.state().sidebarCollapsed, false);
      assert.equal(upgraded.state().composerMinimized, true);
      assert.throws(() => upgraded.setSidebarCollapsed("true"), /侧栏状态无效/);
      upgraded.setSidebarCollapsed(true);
    } finally { upgraded.db.close(); }
    const reopened = new Store(store.root);
    try {
      assert.equal(reopened.state(undefined, true).assetView, "cards");
      assert.equal(reopened.state(project.id).assetView, "cards");
      assert.equal(reopened.state(undefined, true).sidebarCollapsed, true);
      assert.equal(reopened.state(project.id).sidebarCollapsed, true);
      reopened.setComposerMinimized(false);
      assert.equal(reopened.state().sidebarCollapsed, true);
      reopened.setSidebarCollapsed(false);
      assert.equal(reopened.state(project.id).sidebarCollapsed, false);
    } finally { reopened.db.close(); }
  } finally { await close(); }
});

test("执行优先使用项目设置；缺失模型或强度回落到当前目录公布的默认值", () => {
  const models = [
    { id: "A", label: "A", isDefault: false, efforts: ["low"], defaultEffort: "low" },
    { id: "B", label: "B", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }
  ];
  assert.deepEqual(chooseModel(models, "B", "low"), { model: "B", effort: "low" });
  assert.deepEqual(chooseModel(models, "A", "high"), { model: "A", effort: "low" });
  assert.deepEqual(chooseModel(models, "unavailable", "unavailable"), { model: "B", effort: "high" });
  assert.deepEqual(chooseModel(models), { model: "B", effort: "high" });
});

test("按 Codex 返回的游标读取所有可选模型，保留未来新增的推理强度", async () => {
  const cursors: unknown[] = [];
  const call: AppServer["call"] = async <T>(method: string, params = {} as Record<string, unknown>) => {
    assert.equal(method, "model/list");
    assert.equal(params.includeHidden, false);
    cursors.push(params.cursor);
    const first = !params.cursor;
    return { nextCursor: first ? "page-two" : null, data: [
      { model: first ? "first" : "new-model", displayName: "当前模型", hidden: false, defaultReasoningEffort: "new-level",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "new-level" }] },
      { model: "internal", hidden: true }
    ] } as T;
  };
  const result = await listModels({ call });
  assert.deepEqual(cursors, [undefined, "page-two"]);
  assert.deepEqual(result.map(item => item.id), ["first", "new-model"]);
  assert.deepEqual(result[1].efforts, ["low", "new-level"]);
});

test("项目与任务生命周期、版本冲突、手动队列顺序和幂等领取", async () => {
  const { root, store, close } = await fixture();
  try {
    const project = store.saveProject({ title: "待验项目" }, root);
    store.saveProject({ id: project.id, title: "项目改名", version: 1 }, root);
    assert.throws(() => store.saveProject({ id: project.id, title: "旧版本", version: 1 }, root), /已有更新/);
    store.changeLifecycle("projects", { id: project.id, version: 2, lifecycle: "archived" });
    store.changeLifecycle("projects", { id: project.id, version: 3, lifecycle: "trash" });
    store.changeLifecycle("projects", { id: project.id, version: 4, lifecycle: "active" });
    assert.equal(store.project(project.id).lifecycle, "archived");
    store.changeLifecycle("projects", { id: project.id, version: 5, lifecycle: "active" });
    const a = store.saveTask({ projectId: project.id, title: "A", instructions: "验证 A" });
    const b = store.saveTask({ projectId: project.id, title: "B", instructions: "验证 B" });
    store.changeLifecycle("tasks", { id: a.id, version: 1, lifecycle: "trash" });
    store.changeLifecycle("tasks", { id: a.id, version: 2, lifecycle: "active" });
    store.queue({ id: a.id, version: 3 }, "add");
    store.queue({ id: b.id, version: 1 }, "add");
    store.queue({ id: b.id, version: 2, direction: "up" }, "move");
    const params = { id: project.id, version: 6, requestKey: randomUUID() };
    const first = store.claim(params, true);
    assert.equal(first.taskId, b.id);
    assert.equal(store.claim(params, true).id, first.id);
    assert.equal(store.claim(params, true).created, false);
    assert.equal(store.taskRow(a.id).status, "queued");
    assert.equal(store.state(project.id).projects[0].running, 1);
    assert.throws(() => store.changeLifecycle("projects", { id: project.id, version: 6, lifecycle: "archived" }), /待核对/);
  } finally { await close(); }
});

test("固定资产版本、自动登记产物、人工验收和后续交接", async () => {
  const { root, store, files, close } = await fixture();
  try {
    const project = store.saveProject({ title: "项目" }, root);
    const source = join(root, "brief.txt");
    await writeFile(source, "version 1");
    const first = store.importFiles(project.id, [await files.importFile(source)])[0];
    assert.equal(store.importFiles(project.id, [await files.importFile(source)])[0].versionId, first.versionId);
    await writeFile(source, "version 2");
    const newer = store.importFiles(project.id, [await files.importFile(source)])[0];
    assert.notEqual(newer.versionId, first.versionId);
    const task = store.saveTask({
      projectId: project.id, title: "汇编报告", instructions: "按旧版本写报告",
      inputVersionIds: [first.versionId], expectedFiles: ["report.md"],
      textChecks: [{ path: "report.md", contains: "结论" }], reviewCriteria: "核对报告"
    });
    const started = store.claim({ id: task.id, version: 1, requestKey: randomUUID() }, false);
    const run = store.run(started.id);
    assert.deepEqual(run.snapshot.files.map(file => file.id), [first.versionId]);
    await deliver(run, [{ path: "report.md", role: "output" }, { path: "handoff.md", role: "handoff" }],
      { "report.md": "# 结论\n按版本出报告", "handoff.md": "# 交接\n下一任务参考报告" });
    const delivery = await files.collect(run.workDir, run.snapshot);
    const finished = store.finish(run.id, "completed", delivery);
    assert.equal(finished.status, "review");
    assert.equal(finished.files.length, 2);
    assert.equal(store.finish(run.id, "completed", delivery).files.length, 2);
    assert.equal(store.project(project.id).handoffVersionId, null);
    store.review({ runId: run.id, version: 3, decision: "accept", note: "内容已经核对" });
    assert.equal(store.taskRow(task.id).status, "done");
    const handoff = store.project(project.id).handoffVersionId;
    assert.equal(handoff, finished.files.find(file => file.role === "handoff")?.id);
    await files.preview(store.version(project.id, finished.files[0].id));
    const next = store.saveTask({ projectId: project.id, title: "后续", instructions: "读交接" });
    const nextRun = store.run(store.claim({ id: next.id, version: 1, requestKey: randomUUID() }, false).id);
    assert.deepEqual(nextRun.snapshot.files.map(file => file.id), [handoff]);
  } finally { await close(); }
});

test("核验失败保留证据，拒绝越界产物及其他项目的版本", async () => {
  const { root, store, files, close } = await fixture();
  try {
    const firstProject = store.saveProject({ title: "甲" }, root);
    const secondProject = store.saveProject({ title: "乙" }, root);
    const source = join(root, "brief.txt");
    await writeFile(source, "brief");
    const asset = store.importFiles(firstProject.id, [await files.importFile(source)])[0];
    assert.throws(() => store.saveTask({
      projectId: secondProject.id, title: "任务", instructions: "关联其他项目资产", inputVersionIds: [asset.versionId]
    }), /项目内的资产/);
    const task = store.saveTask({ projectId: firstProject.id, title: "任务", instructions: "产生文件", expectedFiles: ["report.md"] });
    const run = store.run(store.claim({ id: task.id, version: 1, requestKey: randomUUID() }, false).id);
    await deliver(run, [{ path: "../brief.txt", role: "output" }], {});
    const delivery = await files.collect(run.workDir, run.snapshot);
    assert.equal(delivery.files.length, 0);
    assert.equal(delivery.checks[0].passed, false);
    assert.equal(store.finish(run.id, "completed", delivery).status, "error");
    assert.equal(store.taskRow(task.id).status, "error");
  } finally { await close(); }
});

test("同一项目目录保留执行占用，确认停止后才能启动新的任务", async () => {
  const { root, store, close } = await fixture();
  try {
    const project = store.saveProject({ title: "项目一" }, root);
    const other = store.saveProject({ title: "项目二" }, root);
    const a = store.saveTask({ projectId: project.id, title: "A", instructions: "验证 A" });
    const b = store.saveTask({ projectId: other.id, title: "B", instructions: "验证 B" });
    const run = store.claim({ id: a.id, version: 1, requestKey: randomUUID() }, false);
    store.requestStop(run.id);
    assert.equal(store.run(run.id).stopRequested, 1);
    store.recover(run.id, "待核对已有运行");
    assert.throws(() => store.claim({ id: b.id, version: 1, requestKey: randomUUID() }, false), /同一目录/);
    store.finish(run.id, "interrupted", { files: [], checks: [], summary: "" });
    assert.equal(store.taskRow(a.id).status, "paused");
    assert.equal(store.claim({ id: b.id, version: 1, requestKey: randomUUID() }, false).taskId, b.id);
  } finally { await close(); }
});

test("按列新建和移动任务保留队序，并让真实回执管理执行和验收状态", async () => {
  const { root, store, close } = await fixture();
  try {
    const project = store.saveProject({ title: "看板项目" }, root);
    const add = (initialStatus: unknown) => store.saveTask({
      projectId: project.id, title: String(initialStatus), instructions: "验证看板操作", initialStatus
    });
    for (const status of taskStatuses) {
      const task = add(status);
      assert.equal(store.taskRow(task.id).status, status);
      assert.equal(Boolean(store.taskRow(task.id).queueRank), status === "queued");
    }
    assert.throws(() => add("invented"), /状态无效/);
    const home = store.state(undefined, true);
    assert.equal(home.projects[0].total, taskStatuses.length);
    assert.deepEqual(taskStatuses.map(status => home.projects[0][status]), taskStatuses.map(() => 1));
    assert.equal(home.projects[0].liveRunStatus, null);
    assert.equal(home.project, null);
    assert.equal(home.tasks.length, 0);

    const task = add("todo");
    const state = () => store.taskRow(task.id);
    const move = (status: string) => store.changeTaskStatus({ id: task.id, version: state().version, status });
    move("queued");
    assert.equal(state().queueRank, 2);
    assert.throws(() => store.changeTaskStatus({ id: task.id, version: 1, status: "error" }), /已有更新/);
    for (const status of taskStatuses.filter(status => status !== "queued")) {
      move(status);
      assert.equal(state().status, status);
      assert.equal(state().queueRank, null);
    }
    assert.equal(store.state(project.id).runs.length, 0);
    move("running");
    store.changeLifecycle("tasks", { id: task.id, lifecycle: "archived", version: state().version });
    store.changeLifecycle("tasks", { id: task.id, lifecycle: "active", version: state().version });
    const run = store.claim({ id: task.id, version: state().version, requestKey: randomUUID() }, false);
    assert.equal(store.state(undefined, true).projects[0].liveRunStatus, "running");
    assert.throws(() => move("done"), /Codex 执行结束/);
    store.recover(run.id, "等待回执");
    assert.equal(store.state(undefined, true).projects[0].liveRunStatus, "recover");
    assert.throws(() => move("error"), /确认中断回执/);
    store.finish(run.id, "completed", { files: [], checks: [], summary: "等待验收" });
    assert.equal(state().status, "review");
    assert.throws(() => move("todo"), /提交验收结论/);
    move("done");
    assert.equal(store.run(run.id).reviewNote, "");
    assert.equal(store.run(run.id).checks.at(-1)?.label, "人工验收通过");
    assert.equal(state().status, "done");
    assert.equal(store.state(undefined, true).projects[0].liveRunStatus, null);
    move("todo");
    assert.equal(store.run(run.id).status, "done");
  } finally { await close(); }
});

test("空白记录可确认验收，手动卡和旧执行可追溯，重复提交不重复验收", async () => {
  const { root, store, close } = await fixture();
  try {
    const project = store.saveProject({ title: "验收" }, root);
    for (const note of [undefined, "   ", "已对照样稿"]) {
      const task = store.saveTask({ projectId: project.id, title: "手动复核", instructions: "核对样稿", initialStatus: "review" });
      const request = { id: task.id, version: 1, decision: "accept", note };
      store.review(request);
      assert.throws(() => store.review(request), /已有更新/);
      const saved = store.task(store.taskRow(task.id));
      assert.equal(saved.status, "done");
      assert.deepEqual(saved.reviews.map(r => [r.decision, r.note, r.runId]), [["accept", note?.trim() ?? "", null]]);
    }
    const task = store.quickCreate({ projectId: project.id, instructions: "旧运行待验收", timing: "now", requestKey: randomUUID() });
    store.finish(task.runId!, "completed", { files: [], checks: [], summary: "首轮" });
    restoreV5Schema(store);
    store.db.exec("DROP TABLE task_reviews; PRAGMA user_version=4;");
    const upgraded = new Store(store.root);
    try {
      const version = upgraded.taskRow(task.taskId).version;
      upgraded.review({ runId: task.runId, version, decision: "accept" });
      assert.equal(upgraded.run(task.runId).checks.at(-1)?.detail, "");
      assert.equal(upgraded.taskRow(task.taskId).status, "done");
    } finally { upgraded.db.close(); }
  } finally { await close(); }
});

test("完成后优化保留人工和自动通过的交付，固定上一轮版本并重新验收", async () => {
  const { root, store, files, close } = await fixture();
  try {
    const project = store.saveProject({ title: "完成后优化" }, root);
    for (const reviewCriteria of ["审核初稿", ""]) {
      const task = store.saveTask({ projectId: project.id, title: "报告", instructions: "写报告",
        expectedFiles: ["report.md"], reviewCriteria });
      const state = () => store.task(store.taskRow(task.id));
      const first = store.claim({ id: task.id, version: state().version, requestKey: randomUUID() }, false);
      const artifacts = [{ path: "report.md", role: "output" }, { path: "handoff.md", role: "handoff" }];
      const finishReport = async (runId: string, body: string) => {
        const run = store.run(runId);
        await deliver(run, artifacts, { "report.md": body, "handoff.md": "交接 " + body });
        return store.finish(runId, "completed", await files.collect(run.workDir, run.snapshot));
      };
      await finishReport(first.id, "第一版");
      if (reviewCriteria) store.review({ id: task.id, runId: first.id, version: state().version, decision: "accept", note: "原版通过" });
      const accepted = store.run(first.id);
      const oldReviews = state().reviews;
      const oldHandoff = store.project(project.id).handoffVersionId;
      assert.equal(accepted.status, "done");
      const values = { id: task.id, version: state().version, runId: first.id, requestKey: randomUUID(), note: "加上结论" };
      assert.throws(() => store.claim(values, false), /当前无法启动/);
      assert.throws(() => store.refine({ ...values, runId: randomUUID() }), /完成记录已变化/);
      assert.throws(() => store.refine({ ...values, version: values.version - 1 }), /已有更新/);
      const busy = store.quickCreate({ projectId: project.id, instructions: "占用项目", timing: "now", requestKey: randomUUID() });
      assert.throws(() => store.refine(values), /已有执行中的任务/);
      assert.deepEqual(state().reviews, oldReviews);
      assert.equal(state().status, "done");
      store.finish(busy.runId!, "interrupted", { files: [], checks: [], summary: "" });
      const next = store.refine(values);
      assert.equal(store.refine(values).created, false);
      assert.equal(store.run(next.id).parentRunId, first.id);
      assert.equal(store.run(next.id).snapshot.refinement?.previousRunId, first.id);
      assert.deepEqual(store.run(next.id).snapshot.files.filter(f => f.previousPath).map(f => f.id).sort(), accepted.files.map(f => f.id).sort());
      assert.equal(state().reviews.at(-1)?.runId, first.id);
      assert.deepEqual(state().reviews.slice(0, -1), oldReviews);
      const revised = await finishReport(next.id, "第二版有结论");
      assert.equal(revised.status, "review");
      assert.equal(store.project(project.id).handoffVersionId, oldHandoff);
      store.review({ id: task.id, runId: next.id, version: state().version, decision: "accept" });
      assert.deepEqual(store.run(first.id), accepted);
      assert.equal(store.project(project.id).handoffVersionId, revised.files.find(f => f.role === "handoff")!.id);
    }
    const manual = store.saveTask({ projectId: project.id, title: "手动完成", instructions: "撰写摘要", initialStatus: "done" });
    const next = store.refine({ id: manual.id, version: store.taskRow(manual.id).version, requestKey: randomUUID(), note: "增加结论" });
    assert.equal(store.run(next.id).parentRunId, null);
    assert.deepEqual(store.run(next.id).snapshot.refinement, { requirements: ["增加结论"], previousRunId: null, previousSummary: "" });
  } finally { await close(); }
});

test("补充需求原子地启动下一轮，继承准确的资产版本；多轮、忙碌回滚和幂等重试", async () => {
  const { root, store, files, close } = await fixture();
  try {
    const project = store.saveProject({ title: "优化" }, root);
    const task = store.saveTask({ projectId: project.id, title: "报告", instructions: "写交付报告", expectedFiles: ["report.md"], initialStatus: "review" });
    const state = () => store.task(store.taskRow(task.id));
    const first = { id: task.id, version: 1, note: "增加背景", requestKey: randomUUID() };
    assert.throws(() => store.refine({ ...first, note: " " }), /补充需求/);
    const initial = store.refine(first);
    assert.equal(store.refine(first).id, initial.id);
    assert.equal(store.refine(first).created, false);
    assert.throws(() => store.refine({ ...first, note: "不同要求" }), /标识已使用/);
    const finish = async (id: string, body: string) => {
      const run = store.run(id);
      await deliver(run, [{ path: "report.md", role: "output" }, { path: "handoff.md", role: "handoff" }], {
        "report.md": body, "handoff.md": "交接 " + body
      });
      return store.finish(id, "completed", await files.collect(run.workDir, run.snapshot));
    };
    const one = await finish(initial.id, "有背景的报告");
    assert.equal(one.status, "review");
    const other = store.quickCreate({ projectId: project.id, instructions: "并行占用检查", timing: "now", requestKey: randomUUID() });
    const second = { id: task.id, runId: one.id, version: state().version, note: "补充结论", requestKey: randomUUID() };
    assert.throws(() => store.refine(second), /已有执行中的任务/);
    assert.equal(store.run(one.id).status, "review");
    assert.equal(state().version, second.version);
    assert.equal(state().reviews.length, 1);
    store.finish(other.runId!, "interrupted", { files: [], checks: [], summary: "" });
    assert.throws(() => store.refine({ ...second, runId: other.runId }), /待验收记录已变化/);
    const next = store.refine(second);
    assert.equal(store.refine(second).created, false);
    assert.equal(store.project(project.id).handoffVersionId, null);
    assert.equal(store.run(one.id).status, "refined");
    const snapshot = store.run(next.id).snapshot;
    assert.equal(snapshot.instructions, "写交付报告");
    assert.deepEqual(snapshot.refinement?.requirements, ["增加背景", "补充结论"]);
    assert.equal(snapshot.refinement?.previousRunId, one.id);
    assert.deepEqual(snapshot.files.map(f => [f.id, f.previousPath]), one.files.map(f => [f.id, f.path]));
    assert.deepEqual(store.run(one.id).snapshot.refinement?.requirements, ["增加背景"]);
    assert.throws(() => store.review({ runId: one.id, version: state().version, decision: "accept" }), /待验收记录已变化/);
    store.finish(next.id, "dispatch_failed", { files: [], checks: [], summary: "" });
    const retried = store.claim({ id: task.id, version: state().version, requestKey: randomUUID() }, false);
    assert.deepEqual(store.run(retried.id).snapshot.refinement, snapshot.refinement);
    const two = await finish(retried.id, "新版报告有结论");
    assert.equal(two.status, "review");
    const acceptance = { id: task.id, version: state().version, status: "done" };
    store.changeTaskStatus(acceptance);
    assert.throws(() => store.changeTaskStatus(acceptance), /已有更新/);
    assert.equal(store.project(project.id).handoffVersionId, two.files.find(f => f.role === "handoff")!.id);
    assert.equal(store.run(retried.id).status, "done");
    assert.deepEqual(state().reviews.map(r => r.decision), ["refine", "refine", "accept"]);
  } finally { await close(); }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Files } from "../src/assets.ts";
import { beginEdit, readEdit, refreshSource, saveEdit } from "../src/asset-edits.ts";
import { actionLines, changeLink, ingestTurns, matchThread, sessionState } from "../src/capture.ts";
import { arrange, layoutState } from "../src/panel-layout.ts";
import { Runner } from "../src/runner.ts";
import { excerptText, inScope, projectSessions } from "../src/ui/session-list.ts";
import { scheduleWindow, policyFor, savePolicy } from "../src/schedule.ts";
import type { Policy } from "../src/schedule.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";
import type { Params } from "../src/types.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "moki-p23-")),
    root = join(dir, "project");
  await mkdir(root);
  const db = new Store(dir),
    files = new Files(dir);
  t.after(async () => {
    db.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = (name: string, category = "", path = root) => db.saveProject({ title: name, category }, path).id;
  const policy = (id: string, patch: Partial<Policy>, roots: string[] = []) =>
    savePolicy(db, { ...policyFor(db, id), ...patch, id }, roots);
  const task = (projectId: string, title: string, status = "queued") =>
    db.saveTask({ projectId, title, instructions: title, initialStatus: status }).id;
  const terminal = { files: [], summary: "", checks: [] };
  return { db, files, root, project, policy, task, terminal };
}

test("分类拖动、跨组插入、折叠与旧布局冲突均可跨重启读回", async (t) => {
  const { db, project } = await fixture(t);
  const a = project("A", "研发"),
    b = project("B", "交付"),
    c = project("C", "研发");
  const move = (params: Params) => arrange(db, { layoutVersion: layoutState(db).layoutVersion, ...params });
  const old = layoutState(db).layoutVersion;
  move({ kind: "project", id: a, version: 1, group: "交付", target: b, after: false });
  move({ kind: "project", id: c, version: 1, group: "交付", target: a, after: true });
  move({ kind: "group", group: "交付", target: "研发", after: false });
  move({ kind: "fold", group: "交付", collapsed: true });
  assert.throws(() => arrange(db, { kind: "group", group: "交付", target: "研发", layoutVersion: old }), /顺序/);
  const reopened = new Store(db.root);
  try {
    const state = reopened.state(undefined, true),
      groups = state.groups.map((g) => g.name);
    assert.deepEqual(
      state.projects.filter((p) => p.category === "交付").map((p) => p.id),
      [a, c, b],
    );
    assert.ok(groups.indexOf("交付") < groups.indexOf("研发"));
    assert.equal(state.groups.find((g) => g.name === "交付")?.collapsed, 1);
  } finally {
    reopened.db.close();
  }
});

test("每周多时段、跨午夜、相邻窗及夏令时重复小时采用真实 UTC 边界", () => {
  const p = {
    mode: "window" as const,
    zone: "Asia/Shanghai",
    windows: [
      { days: [1], start: "23:00", end: "01:00" },
      { days: [2], start: "01:00", end: "02:00" },
    ],
  };
  const at = (s: string) => Date.parse(s);
  assert.equal(scheduleWindow(p, at("2026-11-16T14:59Z")).open, false);
  assert.deepEqual(scheduleWindow(p, at("2026-11-16T15:00Z")), { open: true, next: at("2026-11-16T18:00Z") });
  assert.equal(scheduleWindow(p, at("2026-11-16T18:00Z")).open, false);
  const dst = {
    mode: "window" as const,
    zone: "America/New_York",
    windows: [{ days: [7], start: "01:10", end: "01:40" }],
  };
  for (const hour of ["05", "06"])
    assert.equal(scheduleWindow(dst, at("2026-11-01T" + hour + ":15Z")).next, at("2026-11-01T" + hour + ":40Z"));
});

test("自动队列顺序、同目录互斥、单项失败继续、权限错误暂停、恢复后空闲", async (t) => {
  const { db, root, project, policy, task, terminal } = await fixture(t),
    a = project("A"),
    b = project("B", "", root);
  const a1 = task(a, "第一项"),
    a2 = task(a, "第二项"),
    a3 = task(a, "第三项");
  task(b, "同目录");
  policy(a, { mode: "auto" });
  const [r1] = db.scheduleClaims();
  policy(b, { mode: "auto" });
  assert.equal(db.run(r1).taskId, a1);
  assert.deepEqual(db.scheduleClaims(), []);
  policy(b, { paused: true });
  db.finish(r1, "failed", terminal, "单项核验出错");
  const [r2] = db.scheduleClaims();
  assert.equal(db.run(r2).taskId, a2);
  db.finish(r2, "failed", terminal, "insufficient_quota");
  assert.equal(policyFor(db, a).paused, true);
  policy(b, { paused: false });
  const [other] = db.scheduleClaims();
  assert.equal(db.run(other).projectId, b);
  db.finish(other, "completed", terminal);
  assert.deepEqual(db.scheduleClaims(), []);
  policy(a, { paused: false });
  const [r3] = db.scheduleClaims();
  assert.equal(db.run(r3).taskId, a3);
  db.finish(r3, "completed", terminal);
  assert.deepEqual(db.scheduleClaims(), []);
});

test("跨窗唤醒保留占用，截止前的安全检查点只续跑一次，迟到完成不可重跑", async (t) => {
  const { db, files, project, policy, task, terminal } = await fixture(t),
    p = project("时段"),
    first = task(p, "有检查点"),
    second = task(p, "保持排队");
  policy(p, { mode: "window", zone: "UTC", windows: [{ days: [1, 2, 3], start: "09:00", end: "10:00" }] });
  const day = (n: number, h: string) => Date.parse("2026-11-" + n + "T" + h + "Z");
  const [run] = db.scheduleClaims(day(16, "09:59"));
  assert.equal(db.run(run).taskId, first);
  const path = join(db.root, "handoff.md");
  await writeFile(path, "安全检查点");
  const file = await files.ingest(path);
  db.checkpoint(
    run,
    {
      checks: [],
      summary: "已完成第一段",
      files: [{ ...file, path: "handoff.md", role: "handoff" }],
      resumeSafe: true,
    },
    day(16, "09:59"),
  );
  const interrupts: string[] = [];
  const clock = new Scheduler(db, {
    stop: (id: string) => interrupts.push(id),
    isActive: () => true,
    start: () => assert.fail("回执前不应派发"),
  } as unknown as Runner);
  clock.tick(day(17, "09:01"));
  assert.equal(db.run(run).stopReason, "window");
  assert.deepEqual(interrupts, [run]);
  assert.deepEqual(db.scheduleClaims(day(17, "09:02")), []);
  assert.equal(db.taskRow(second).status, "queued");
  db.finish(run, "interrupted", terminal, "", null, day(17, "09:02"));
  const [next] = db.scheduleClaims(day(17, "09:03")),
    record = db.run(next);
  assert.equal(record.parentRunId, run);
  assert.ok(record.snapshot.files.some((f) => f.id === db.run(run).files[0].id));
  assert.deepEqual(db.scheduleClaims(day(17, "09:04")), []);
  db.finish(next, "completed", terminal, "", null, day(17, "10:03"));
  assert.equal(db.run(next).status, "paused");
  assert.equal(db.run(db.scheduleClaims(day(18, "09:01"))[0]).taskId, second);
});

test("审批限定到准确回合；中断释放等待并拒绝旧批准，重放不会重复登记", async (t) => {
  const { db, files, project, task } = await fixture(t),
    p = project("审批"),
    id = task(p, "文件操作");
  const claim = db.claim({ id, version: 1, requestKey: randomUUID() }, false);
  const threadId = randomUUID(),
    turnId = randomUUID(),
    runner = new Runner(db, files);
  db.progress(claim.id, "执行中", threadId, turnId);
  const method = "item/commandExecution/requestApproval",
    args = { threadId, turnId, itemId: "a", command: "读取工作目录" };
  assert.deepEqual(await runner.approval(claim.id, method, { ...args, turnId: randomUUID() }), { decision: "decline" });
  const first = runner.approval(claim.id, method, args),
    replay = runner.approval(claim.id, method, args);
  const a = db.run(claim.id).approvals[0];
  assert.equal(db.run(claim.id).approvals.length, 1);
  runner.decide(a.id, claim.id, "accept");
  assert.deepEqual(await first, await replay);
  const pending = runner.approval(claim.id, method, { ...args, itemId: "b" });
  db.requestStop(claim.id);
  runner.stop(claim.id);
  assert.deepEqual(await pending, { decision: "decline" });
  assert.throws(() => runner.decide(db.run(claim.id).approvals[1].id, claim.id, "accept"), /失效/);
});

test("资产编辑基于不可变版本，并发冲突可比较和另存，原文件独立更新", async (t) => {
  const { db, files, root, project } = await fixture(t),
    p = project("资产"),
    path = join(root, "并发.md");
  await writeFile(path, "甲");
  const [asset] = db.importFiles(p, [await files.importFile(path)]);
  const args = { projectId: p, assetId: asset.id, versionId: asset.versionId };
  const [a, b] = await Promise.all([beginEdit(db, files, args), beginEdit(db, files, args)]);
  const two = await saveEdit(db, files, { projectId: p, id: a.id, content: "乙" });
  assert.ok("conflict" in (await saveEdit(db, files, { projectId: p, id: b.id, content: "丙" })));
  const read = await readEdit(db, files, { projectId: p, id: b.id });
  assert.equal(read.latestText, "乙");
  const three = await saveEdit(db, files, { projectId: p, id: b.id, content: "丙", expectedLatest: two.versionId });
  assert.equal(db.version(p, three.versionId).revision, 3);
  assert.equal(await readFile(path, "utf8"), "甲");
  await writeFile(path, "源已变");
  await assert.rejects(refreshSource(db, files, { ...args, expectedLatest: two.versionId }), /已更新/);
  await refreshSource(db, files, { ...args, expectedLatest: three.versionId });
  assert.equal(db.state(p).assets[0].versions.length, 4);
  assert.equal(db.version(p, asset.versionId).revision, 1);
});

test("会话列表合并相同聊天，保留每次执行和有效来源，按真实活动时间排序", async t => {
  const { db, files, project, root, task, policy, terminal } = await fixture(t);
  const pid = project("会话索引");
  policy(pid, { capture: true });
  const meta = { id: randomUUID(), cwd: root, updatedAt: 10, name: "发布讨论" };
  const firstTask = task(pid, "核对初稿");
  for (const taskId of [firstTask, task(pid, "补充结论")]) {
    const run = db.claim({ id: taskId, version: 1, requestKey: randomUUID() }, false);
    db.progress(run.id, "执行中", meta.id, randomUUID());
    db.finish(run.id, "completed", terminal);
  }
  const link = matchThread(db, meta)!;
  const path = join(root, "交付规范.md");
  await writeFile(path, "第一版");
  const [asset] = db.importFiles(pid, [await files.importFile(path)]);
  ingestTurns(db, link, [{ id: randomUUID(), status: "completed",
    items: [{ type: "userMessage", id: randomUUID(), content: [{ type: "text", text: "待办：复核目录\n[检查依据](交付规范.md)" }] }]
  }], 10, "初稿已完成");
  const second = matchThread(db, { id: randomUUID(), name: "仅匹配目录", cwd: root, updatedAt: 20 })!;
  let entries = projectSessions(db.state(pid)).entries;
  assert.deepEqual(entries.map(e => e.id), [meta.id, second.threadId]);
  assert.equal(entries[0].runs.length, 2);
  assert.equal(entries[0].sources.length, 1);
  assert.equal(entries[0].refs[0].versionId, asset.versionId);
  assert.equal(excerptText("## 请查看 [验收规范](交付规范.md)"), "请查看 验收规范");
  assert.ok(["核对初稿", "补充结论", "复核目录", "初稿已完成", meta.id].every(s => entries[0].searchText.includes(s)));
  changeLink(db, { projectId: pid, threadId: meta.id, version: link.version, operation: "undo" });
  const ignored = projectSessions(db.state(pid)).entries.find(e => e.id === meta.id)!;
  assert.equal(ignored.sources.length, 0);
  assert.ok(!ignored.searchText.includes("初稿已完成"));
  assert.ok(inScope(ignored, "linked") && inScope(ignored, "ignored") && !inScope(ignored, "pending"));
  const other = project("重复目录");
  policy(other, { capture: true });
  const candidate = matchThread(db, { id: randomUUID(), cwd: root, updatedAt: 30, preview: "私有正文" })!;
  entries = projectSessions(db.state(pid)).entries;
  const pending = entries.find(e => e.id === candidate.threadId)!;
  assert.ok(inScope(pending, "pending") && !inScope(pending, "linked"));
  assert.equal(pending.activity, 0);
  assert.ok(!pending.searchText.includes("私有正文"));
});

test("重叠授权候选、重复采集、手动归属、忽略撤销、保留人工更新与关闭授权", async (t) => {
  const { db, root, project, policy } = await fixture(t),
    nested = join(root, "worktree");
  await mkdir(nested);
  const a = project("父"),
    b = project("子", "", nested),
    meta = { id: randomUUID(), cwd: nested, updatedAt: 17 };
  policy(a, { capture: true }, [nested]);
  policy(b, { capture: true });
  const candidate = matchThread(db, meta)!;
  assert.equal(candidate.kind, "candidate");
  assert.deepEqual(JSON.parse(candidate.choices).sort(), [a, b].sort());
  const turns = [
    {
      id: randomUUID(),
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: randomUUID(),
          content: [{ type: "text", text: "待办：校对交接\n- [ ] 整理文件\n是否更新？" }],
        },
      ],
    },
  ];
  ingestTurns(db, candidate, turns, 17, "");
  assert.equal(db.state(a).tasks.length, 0);
  changeLink(db, { projectId: a, threadId: meta.id, version: candidate.version });
  const manual = matchThread(db, meta)!;
  ingestTurns(db, manual, turns, 17, "交接");
  ingestTurns(db, manual, turns, 17, "交接");
  const state = db.state(a);
  assert.equal(state.tasks.length, 2);
  assert.ok(state.tasks.every((t) => t.status === "todo"));
  const changed = state.tasks[0];
  db.saveTask({ ...changed, instructions: "人工编辑保留" });
  changeLink(db, { projectId: a, threadId: meta.id, version: manual.version, operation: "undo" });
  const after = db.state(a);
  assert.equal(after.tasks.filter((t) => t.lifecycle === "active").length, 1);
  assert.equal(db.taskRow(changed.id).instructions, "人工编辑保留");
  assert.ok(sessionState(db, a).sources.every((s) => s.status === "withdrawn"));
  assert.equal(matchThread(db, meta)?.kind, "ignored");
  const ignored = matchThread(db, meta)!;
  changeLink(db, { projectId: a, targetProjectId: b, threadId: meta.id, version: ignored.version });
  const moved = matchThread(db, meta)!;
  policy(b, { capture: false });
  ingestTurns(db, moved, turns, 19, "关闭后");
  assert.equal(db.state(b).tasks.length, 0);
  const twin=project("父","",join(root,"sibling"));
  policy(twin,{capture:true});
  const fork=matchThread(db,{id:randomUUID(),cwd:join(root,"sibling"),forkedFromId:meta.id,updatedAt:20})!;
  assert.equal(fork.parentId,meta.id);
  assert.equal(fork.kind,"candidate");
  assert.deepEqual(JSON.parse(fork.choices).sort(),[a,twin].sort());
  ingestTurns(db,fork,turns,20,"分叉会话独立判定");
  assert.equal(db.state(twin).tasks.length,0);
  assert.equal(actionLines("如何修复？\n```\n新增任务\n```").length, 0);
});

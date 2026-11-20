import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { activityPeriods, activityRange, activityRanges, activityStart, calendarWeeks, localDay } from "../src/calendar.ts";
import { saveRelease, activityDays } from "../src/project-dashboard.ts";

async function fixture(t: TestContext) {
  const dir=await mkdtemp(join(tmpdir(),"moki-dashboard-test-")), db=new Store(dir);
  t.after(async()=>{db.db.close();await rm(dir,{force:true,recursive:true});});
  const project=(title:string)=>db.saveProject({title,description:""},dir).id;
  const task=(projectId:string,title:string)=>db.saveTask({projectId,title,instructions:title}).id;
  return {dir,db,project,task};
}

test("任务热力图按本地自然日去重，覆盖人工和验收活动，隔离项目和回收站",async t=>{
  const {db,project,task}=await fixture(t);
  const a=project("A"),b=project("B"),a1=task(a,"A1"),a2=task(a,"A2"),b1=task(b,"B1");
  db.changeTaskStatus({id:a1,version:1,status:"review"});
  db.changeTaskStatus({id:a1,version:2,status:"done"});
  assert.equal(db.state(a).tasks.find(t=>t.id===a1)!.reviews[0].decision,"accept");
  const now=new Date(), earlier=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1,12);
  db.write("INSERT INTO task_activity VALUES(?,?)",a1,earlier.toISOString());
  db.changeLifecycle("tasks",{id:a2,version:1,lifecycle:"trash"});
  assert.deepEqual(activityDays(db,a),[{day:localDay(earlier),taskIds:[a1]},{day:localDay(now),taskIds:[a1]}]);
  assert.deepEqual(activityDays(db,b)[0].taskIds,[b1]);
  const weeks=calendarWeeks(new Date(2026,0,1,0,1));
  assert.equal(weeks.length,13);assert.equal(weeks.at(-1)![3],"2026-01-01");assert.equal(new Set(weeks.flat()).size,91);
});
test("热力图使用所选自然周窗口，包含边界与历史会话活动", async t => {
  const { db, project, task } = await fixture(t);
  const p = project("历史交付"), first = task(p, "交付文件"), second = task(p, "复核记录");
  const today = new Date(2025, 0, 7, 12);
  const start = activityStart(today, 52);
  const record = (taskId: string, at: Date) => db.write("INSERT INTO task_activity VALUES(?,?)", taskId, at.toISOString());
  record(second, new Date(start.getTime() - 1));
  record(first, start);
  const past = new Date(2024, 4, 4, 18);
  db.write(`INSERT INTO conversation_updates(id,projectId,threadId,turnId,itemId,taskId,kind,author,summary,quote,occurredAt)
    VALUES(?,?,'chat','turn','item',?,'progress','user','复核','复核',?)`, "progress", p, second, past.toISOString());
  record(second, past);
  record(first, new Date(2025, 0, 7, 23, 59, 59, 999));
  record(second, new Date(2025, 0, 8, 0));
  assert.deepEqual(activityDays(db, p, 52, today), [
    {day:localDay(start), taskIds:[first]}, {day:"2024-05-04", taskIds:[second]}, {day:"2025-01-07", taskIds:[first]}
  ]);
  assert.deepEqual(activityDays(db, p, 13, today), [{day:"2025-01-07", taskIds:[first]}]);
  for (const range of activityRanges) {
    const weeks = calendarWeeks(today, range);
    assert.equal(weeks.length, range);
    assert.equal(weeks[0][0], localDay(activityStart(today, range)));
    assert.equal(new Set(weeks.flat()).size, range * 7);
  }
  assert.equal(activityRange(999), 13);
  assert.equal(db.state(p, false, 52).dashboard?.activityWeeks, 52);
});

test("按日、周、月分别去重，跨月自然周与闰日按实际显示区间归集", () => {
  const weeks = calendarWeeks(new Date(2024, 2, 1, 12), 1);
  const activity = [
    {day:"2024-02-25", taskIds:["outside"]}, {day:"2024-02-26", taskIds:["A"]},
    {day:"2024-02-29", taskIds:["A", "B"]}, {day:"2024-03-01", taskIds:["A", "C"]},
    {day:"2024-03-02", taskIds:["future"]}
  ];
  const days = activityPeriods(weeks, "2024-03-01", "day", activity);
  assert.equal(days.length, 5);
  assert.deepEqual(days[2].taskIds, []);
  assert.deepEqual(days[3].taskIds, ["A","B"]);
  assert.deepEqual(activityPeriods(weeks, "2024-03-01", "week", activity), [
    {start:"2024-02-26", end:"2024-03-01", taskIds:["A","B","C"]}
  ]);
  assert.deepEqual(activityPeriods(weeks, "2024-03-01", "month", activity), [
    {start:"2024-02-26", end:"2024-02-29", taskIds:["A","B"]},
    {start:"2024-03-01", end:"2024-03-01", taskIds:["A","C"]}
  ]);
});
test("上线版本支持回填、纠错与重启，版本名按项目去重并校验上线日期和并发写入", async t=>{
  const {dir,db,project}=await fixture(t);
  const a=project("A"),b=project("B");
  const v=saveRelease(db,{projectId:a,label:"v2",releasedOn:"2025-02-02",notes:"修复导出"}).id;
  saveRelease(db,{projectId:a,label:"v1",releasedOn:"2025-02-01"});
  saveRelease(db,{projectId:b,label:"v2",releasedOn:"2025-02-02"});
  assert.throws(()=>saveRelease(db,{projectId:a,label:"V2",releasedOn:"2025-02-02"}),/已登记/);
  for(const day of ["2025-02-29","2025-13-01","2999-01-01"]) assert.throws(()=>saveRelease(db,{projectId:a,label:"错误日期",releasedOn:day}),/日期/);
  saveRelease(db,{projectId:a,id:v,version:1,label:"v2",releasedOn:"2025-02-03",notes:"校对上线日期"});
  assert.throws(()=>saveRelease(db,{projectId:a,id:v,version:1,label:"v2",releasedOn:"2025-02-03"}),/刷新/);
  assert.throws(()=>saveRelease(db,{projectId:b,id:v,version:2,label:"其他",releasedOn:"2025-02-03"}));
  const reopened=new Store(dir);
  try{assert.deepEqual(reopened.state(a).dashboard?.releases.map(r=>[r.label,r.notes]),[["v2","校对上线日期"],["v1",""]]);}
  finally{reopened.db.close();}
});
test("v9 项目首次迁移按既有时间回填活动，版本栏从真实登记开始",async t=>{
  const {dir,db,project,task}=await fixture(t);
  const a=project("历史项目"),tid=task(a,"历史任务");
  db.db.exec("DROP TABLE conversation_files; DROP TABLE conversation_owned_assets; ALTER TABLE capture_items DROP COLUMN stateProof; DROP TRIGGER activity_create; DROP TRIGGER activity_status; DROP TABLE task_activity; DROP TABLE conversation_updates; DROP TABLE project_releases; PRAGMA user_version=9;");
  const migrated=new Store(dir);
  try{assert.equal(migrated.get<{user_version:number}>("PRAGMA user_version")?.user_version,13);
    assert.deepEqual(migrated.state(a).dashboard?.releases,[]);assert.deepEqual(activityDays(migrated,a)[0].taskIds,[tid]);}
  finally{migrated.db.close();}
});


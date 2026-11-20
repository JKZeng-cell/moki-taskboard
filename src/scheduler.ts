import type { Store } from "./store.ts";
import type { Runner } from "./runner.ts";
import { policyFor, scheduleWindow } from "./schedule.ts";

export class Scheduler {
  private db: Store;
  private runner: Runner;
  private sampling = new Set<string>();
  private sampleAfter = new Map<string, number>();
  private recoverAfter = new Map<string, number>();
  constructor(db: Store, runner: Runner) {
    this.db = db;
    this.runner = runner;
  }
  tick(at = Date.now()) {
    const live = this.db.all<{
      id: string;
      projectId: string;
      deadline: number | null;
      status: string;
      stopRequested: number;
    }>("SELECT id,projectId,deadline,status,stopRequested FROM runs WHERE status IN ('running','recover')");
    for (const run of live) {
      if (
        run.deadline !== null &&
        at < run.deadline &&
        !run.stopRequested &&
        !this.sampling.has(run.id) &&
        (this.sampleAfter.get(run.id) ?? 0) <= at
      ) {
        this.sampling.add(run.id);
        this.sampleAfter.set(run.id, at + 5000);
        void this.runner
          .sampleCheckpoint(run.id, at)
          .catch(() => {})
          .finally(() => this.sampling.delete(run.id));
      }
      const policy = policyFor(this.db, run.projectId);
      const outside = policy.mode === "window" && !scheduleWindow(policy, at).open;
      if (!run.stopRequested && (outside || (run.deadline !== null && at >= run.deadline))) {
        if (run.status === "running") this.db.requestStop(run.id, "window", at);
        else this.db.write("UPDATE runs SET stopRequested=1,stopReason='window',stopAt=? WHERE id=?", at, run.id);
      }
      if (run.stopRequested || outside || (run.deadline !== null && at >= run.deadline)) this.runner.stop(run.id);
      if (!this.runner.isActive(run.id) && (this.recoverAfter.get(run.id) ?? 0) <= at) {
        this.recoverAfter.set(run.id, at + 30000);
        void this.runner.reconcile(run.id).catch((e) => this.db.recover(run.id, String(e)));
      }
    }
    for (const id of this.sampleAfter.keys()) if (!live.some((run) => run.id === id)) this.sampleAfter.delete(id);
    for (const id of this.recoverAfter.keys()) if (!live.some((run) => run.id === id)) this.recoverAfter.delete(id);
    for (const id of this.db.scheduleClaims(at)) this.runner.start(id);
  }
}

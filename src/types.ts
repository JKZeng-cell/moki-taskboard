import type { ActivityWeeks } from "./calendar.ts";

export type Lifecycle = "active" | "archived" | "trash";
export type TaskStatus = "todo" | "queued" | "running" | "review" | "done" | "error" | "paused";

export interface CapturedState {
  status: TaskStatus; quote: string; author: "user" | "assistant"; threadId?: string; turnId: string; itemId: string;
  at: number; itemIndex: number; offset: number;
}
export type RunStatus = "running" | "recover" | "review" | "done" | "error" | "paused" | "returned" | "refined";
export type AssetView = "list" | "cards";
export type AssetRole = "input" | "context" | "output" | "handoff";
export type Params = Record<string, unknown>;
export type SessionChoice = {mode:"auto"|"new"} | {mode:"existing";threadId:string};
export interface SessionOption {threadId:string;title:string}
export type QuickTiming = "todo" | "now";

export interface ModelOption {
  id: string;
  label: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort: string | null;
}

export interface Project {
  sortOrder: number;
  id: string;
  category: string;
  title: string;
  description: string;
  root: string;
  permission?: string;
  preferredModel: string | null;
  preferredEffort: string | null;
  lifecycle: Lifecycle;
  version: number;
  handoffVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem extends Project {
  total: number;
  done: number;
  queued: number;
  running: number;
  todo: number;
  review: number;
  error: number;
  paused: number;
  liveRunStatus: "running" | "recover" | null;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  instructions: string;
  expectedFiles: string[];
  textChecks: TextCheck[];
  reviewCriteria: string;
  lifecycle: Lifecycle;
  status: TaskStatus;
  queueRank: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  inputVersionIds: string[];
  reviews: TaskReview[];
}

export interface TaskReview {
  seq: number;
  decision: "accept" | "return" | "refine";
  runId: string | null;
  note: string;
  createdAt: string;
}

export interface TextCheck {
  path: string;
  contains: string;
}

export type DeliveryPreview =
  | {kind:"image";src:string;label?:string}
  | {kind:"markdown"|"html"|"text"|"excerpt";text:string;truncated:boolean}
  | {kind:"audio";src:string}
  | {kind:"video";src:string}
  | {kind:"entries";entries:string[];total:number}
  | {kind:"native";reason:string};

export interface AssetVersion {
  id: string;
  assetId: string;
  revision: number;
  fileName: string;
  sha256: string;
  size: number;
  createdAt: string;
}

export interface Asset {
  id: string;
  groupName: string;
  name: string;
  role: "user" | "output" | "handoff";
  sourcePath: string;
  lifecycle: Lifecycle;
  context: number;
  version: number;
  versions: AssetVersion[];
}

export interface InputFile extends AssetVersion {
  name: string;
  role: "input" | "context" | "handoff" | "previous";
  previousPath?: string;
  refinementAttachment?: true;
}

export interface ProjectRelease { id: string; projectId: string; label: string; releasedOn: string; notes: string; version: number }
export interface ActivityDay { day: string; taskIds: string[] }
export interface ConversationUpdate {
  id: string; projectId: string; threadId: string; turnId: string; itemId: string; taskId: string | null; runId: string | null;
  kind: "handoff" | "progress"; author: "user" | "assistant"; summary: string; quote: string; occurredAt: string; current: number;
}
export interface Snapshot {
  sessionChoice?: SessionChoice;
  conversationHandoff?: Pick<ConversationUpdate, "id"|"summary"|"quote"|"author"|"threadId"|"turnId"|"occurredAt"|"taskId">[];
  checkpoint?: { runId: string; summary: string };
  taskVersion: number;
  title: string;
  instructions: string;
  projectTitle: string;
  projectDescription: string;
  projectRoot: string;
  permission?: string;
  preferredModel?: string | null;
  preferredEffort?: string | null;
  expectedFiles: string[];
  textChecks: TextCheck[];
  reviewCriteria: string;
  files: InputFile[];
  handoffVersionId: string | null;
  refinement?: { requirements: string[]; previousRunId: string | null; previousSummary: string; attachmentFingerprint?: string };
}

export interface Check {
  label: string;
  passed: boolean;
  detail: string;
}

export interface Run {
  route?: { kind: "new" | "resume"; reason: string };
  permission?: string;
  inputVersionIds?: string[];
  refinementAttachments?: Pick<AssetVersion, "id" | "fileName" | "revision">[];
  checkpointSafe?: boolean;
  criteria?: Pick<Task,"reviewCriteria"|"expectedFiles"|"textChecks">;
  deadline: number | null;
  stopAt: number | null;
  stopReason: string | null;
  parentRunId: string | null;
  approvals: Approval[];
  id: string;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turnDurationMs: number | null;
  taskId: string;
  projectId: string;
  status: RunStatus;
  phase: string;
  workDir: string;
  threadId: string | null;
  turnId: string | null;
  modelStatus: string | null;
  effectiveModel: string | null;
  effectiveEffort: string | null;
  startedAt: string;
  endedAt: string | null;
  stopRequested: number;
  summary: string;
  error: string;
  checks: Check[];
  reviewNote: string;
  files: (AssetVersion & { path: string; role: "output" | "handoff" })[];
}

export interface RunRecord extends Run {
  snapshot: Snapshot;
}

export interface ConversationFile {
  id:string; threadId:string; turnId:string; runId?:string|null; taskId:string|null; role:"material"|"output";
  path:string; quote:string; versionId:string|null; issue:string; assetId:string|null; fileName:string|null; revision:number|null;
}

export interface BoardState {
  dashboard?: { activityWeeks: ActivityWeeks; activity: ActivityDay[]; releases: ProjectRelease[]; updates: ConversationUpdate[] };
  groups: import("./panel-layout.ts").ProjectGroup[];
  layoutVersion: number;
  window?: {open:boolean;next:number|null}|null;
  scanError?: string;
  semantics?: { pending: number; error: string };
  policy: import("./schedule.ts").Policy | null;
  sessions: {links: import("./capture.ts").Link[]; sources: import("./capture.ts").Source[];refs?:import("./capture.ts").CapturedRef[]; files?:ConversationFile[]};
  edits: AssetEdit[];
  sidebarCollapsed: boolean;
  assetView: AssetView;
  composerMinimized: boolean;
  projects: ProjectListItem[];
  project: Project | null;
  tasks: Task[];
  assets: Asset[];
  runs: Run[];
}

export interface Approval {id:string;kind:string;detail:string;status:string;createdAt:string}
export interface PendingApproval extends Approval {runId:string; threadId:string; projectId:string; projectTitle:string; taskTitle:string}
export interface PermissionOption {value:string;name:string;description:string}
export interface AssetEdit {id:string;assetId:string;baseId:string;fileName:string;createdAt:string}

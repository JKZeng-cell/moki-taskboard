import { isDsh } from "./host-identity.ts";
import type { PermissionOption } from "./types.ts";

export const codexPermissions: PermissionOption[] = [
  {value:"default",name:"工作区写入 · 按需审批",description:"可在本次任务目录内写入，越界操作由 Codex 请求审批。"},
  {value:"read-only",name:"只读 · 按需审批",description:"读取资料，文本交付可通过会话回复登记。"},
  {value:"review",name:"工作区写入 · 审批非受信命令",description:"Codex 会对非受信命令请求审批。"},
  {value:"full-access",name:"完全访问",description:"允许访问当前系统账户可用的文件与网络。仅对领取后的任务生效。"}
];

export function permissionLabel(value?:string) {
  if(isDsh)return !value||value==="default"?"DSH 默认权限":value.replace(/^dsh:/,"");
  return codexPermissions.find(o=>o.value===(value??"default"))?.name??value;
}

export function codexPermission(value: string | undefined, root: string) {
  const selected = value ?? "default";
  if (!codexPermissions.some(option => option.value === selected)) throw Error("项目默认权限在当前 Codex 中不可用，请编辑项目重新选择。");
  const sandbox = selected === "read-only" ? "read-only" : selected === "full-access" ? "danger-full-access" : "workspace-write";
  const sandboxPolicy = sandbox === "read-only" ? {type:"readOnly",networkAccess:false} :
    sandbox === "danger-full-access" ? {type:"dangerFullAccess"} :
    {type:"workspaceWrite",writableRoots:[root],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  return {sandbox,sandboxPolicy,approvalPolicy:selected === "review" ? "untrusted" : "on-request"};
}

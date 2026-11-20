import { execFile } from "node:child_process";
import { isDsh } from "./host-identity.ts";
import type { Store } from "./store.ts";
import type { PendingApproval } from "./types.ts";

export function pendingApprovals(store:Store) {
  return store.all<PendingApproval>(`SELECT a.id,a.kind,a.detail,a.status,a.createdAt,a.runId,a.threadId,
    r.projectId,p.title projectTitle,t.title taskTitle FROM run_approvals a JOIN runs r ON r.id=a.runId
    JOIN projects p ON p.id=r.projectId JOIN tasks t ON t.id=r.taskId
    WHERE a.status='pending' AND (r.status='running' OR (r.status='recover' AND a.kind='dsh/approval')) AND r.stopRequested=0 AND (r.deadline IS NULL OR r.deadline>?)
    AND r.turnId=a.turnId AND r.threadId=a.threadId ORDER BY a.createdAt,a.id`,Date.now());
}

const toastScript = `
$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null
$doc=New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml('<toast><visual><binding template="ToastGeneric"><text>MOKI 任务需要审批</text><text></text></binding></visual></toast>')
$doc.GetElementsByTagName('text').Item(1).AppendChild($doc.CreateTextNode($env:MOKI_APPROVAL_TITLE)) | Out-Null
$toast=[Windows.UI.Notifications.ToastNotification]::new($doc)
$toast.Tag=$env:MOKI_APPROVAL_TAG
$toast.ExpirationTime=[DateTimeOffset]::Now.AddMinutes(5)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:MOKI_APPROVAL_APP).Show($toast)
`;
export function notifyApproval(store:Store,runId:string,id:string) {
  if(process.platform!=="win32" || process.env.MOKI_TASKBOARD_TEST_NO_TOAST==="1") return;
  const row=store.get<{project:string;task:string}>("SELECT p.title project,t.title task FROM runs r JOIN projects p ON p.id=r.projectId JOIN tasks t ON t.id=r.taskId WHERE r.id=?",runId);
  if(!row) return;
  execFile("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(toastScript,"utf16le").toString("base64")],{
    windowsHide:true,timeout:12000,env:{...process.env,MOKI_APPROVAL_TITLE:(row.project+" · "+row.task).slice(0,200)+"。打开任务台处理。",
      MOKI_APPROVAL_TAG:id.slice(0,16),MOKI_APPROVAL_APP:isDsh?"com.deepseek.dsh":"OpenAI.Codex_2p2nqsd0c76g0!App"}
  },error=>{if(error){try{store.event(runId,"系统通知发送失败，待审批操作已在任务台显示");}catch{ /* Service may be closing. */ }}});
}

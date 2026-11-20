import { AppServer } from "./app-server.ts";
import type { ModelOption } from "./types.ts";

type CatalogModel = {
  model: string; displayName?: string; isDefault?: boolean; hidden?: boolean;
  defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string }[];
};

export async function listModels(server: Pick<AppServer, "call">): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  let cursor: string | undefined;
  do {
    const page = await server.call<{ data: CatalogModel[]; nextCursor?: string }>("model/list", {
      cursor, includeHidden: false, limit: 100
    });
    for (const item of page.data) {
      if (item.hidden || !item.model) continue;
      models.push({
        id: item.model, label: item.displayName || item.model, isDefault: Boolean(item.isDefault),
        efforts: item.supportedReasoningEfforts?.map(level => level.reasoningEffort).filter(Boolean) ?? [],
        defaultEffort: item.defaultReasoningEffort || null
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  if (!models.length) throw new Error("当前 Codex 执行端未返回可用模型，请检查登录状态。");
  return models;
}

async function readCurrentModels(cwd: string) {
  const server = await AppServer.open(cwd);
  try {
    await server.initialize();
    return await listModels(server);
  } finally { server.close(); }
}

let reading: Promise<ModelOption[]> | undefined;
export function availableModels(cwd: string) {
  reading ??= readCurrentModels(cwd).finally(() => { reading = undefined; });
  return reading;
}

export function chooseModel(models: ModelOption[], preferred?: string | null, effort?: string | null) {
  const model = models.find(item => item.id === preferred) ?? models.find(item => item.isDefault) ?? models[0];
  return { model: model.id, effort: effort && model.efforts.includes(effort) ? effort : model.defaultEffort };
}

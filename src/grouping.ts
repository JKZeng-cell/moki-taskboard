// Keep the empty group distinct even when a user chooses the same display name.
export function groupsBy<T>(items: T[], nameOf: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = nameOf(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return [...groups].sort(([a], [b]) => a && b ? a.localeCompare(b, "zh-CN", { numeric: true }) : Number(!a) - Number(!b));
}

export function fileExtension(fileName: string) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toUpperCase() : "";
}

export function fileType(fileName: string) {
  const extension = fileExtension(fileName);
  return extension ? extension + " 文件" : "无扩展名";
}

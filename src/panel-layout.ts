import type { Store } from "./store.ts";
import type { Params } from "./types.ts";
import { text } from "./validation.ts";

export interface ProjectGroup {
  name: string;
  position: number;
  collapsed: number;
}

export function layoutState(db: Store) {
  return {
    groups: db.all<ProjectGroup>("SELECT name,position,collapsed FROM project_groups ORDER BY position,name"),
    layoutVersion: db.get<{ layoutVersion: number }>("SELECT layoutVersion FROM panel_settings WHERE id=1")!
      .layoutVersion,
  };
}

export function arrange(db: Store, p: Params) {
  return db.transaction(() => {
    const layout = layoutState(db);
    const name = text(p.group, "项目分类", 60, true);
    if (!layout.groups.some((g) => g.name === name)) throw new Error("目标分类已变化，请刷新。");
    if (p.kind === "fold") {
      if (typeof p.collapsed !== "boolean") throw new Error("分类状态无效。");
      db.write("UPDATE project_groups SET collapsed=? WHERE name=?", Number(p.collapsed), name);
      return;
    }
    if (p.layoutVersion !== layout.layoutVersion) throw new Error("项目顺序已更新，请刷新后重试。");
    const after = p.after === true;
    if (p.kind === "group") {
      const target = text(p.target, "目标分类", 60, true);
      if (target === name) return;
      const names = layout.groups.map((g) => g.name).filter((g) => g !== name);
      const index = names.indexOf(target);
      if (index < 0) throw new Error("目标分类不存在。");
      names.splice(index + Number(after), 0, name);
      names.forEach((n, i) => db.write("UPDATE project_groups SET position=? WHERE name=?", i, n));
    } else if (p.kind === "project") {
      const project = db.project(p.id, true);
      db.assertVersion(project, p.version);
      if (p.target === project.id) return;
      const ids = db
        .all<{
          id: string;
        }>("SELECT id FROM projects WHERE category=? AND id<>? AND lifecycle='active' ORDER BY sortOrder,id", name, project.id)
        .map((r) => r.id);
      const index = p.target == null ? ids.length : ids.indexOf(String(p.target));
      if (index < 0) throw new Error("目标卡片已移出该分类。");
      ids.splice(index + Number(after), 0, project.id);
      if (project.category !== name)
        db.write(
          "UPDATE projects SET category=?,version=version+1,updatedAt=? WHERE id=?",
          name,
          new Date().toISOString(),
          project.id,
        );
      ids.forEach((id, i) => db.write("UPDATE projects SET sortOrder=? WHERE id=?", i, id));
    } else throw new Error("未知的排列操作。");
    db.write("UPDATE panel_settings SET layoutVersion=layoutVersion+1 WHERE id=1");
  });
}

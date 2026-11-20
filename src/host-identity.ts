declare const __MOKI_DSH__: boolean;
export const isDsh = typeof __MOKI_DSH__ !== "undefined" && __MOKI_DSH__;
export const hostName = isDsh ? "DSH" : "Codex";
export const sessionPrefix = isDsh ? "dsh://sessions/" : "codex://threads/";
export function parseSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const raw=value.trim();
  const input=raw.toLowerCase().startsWith(sessionPrefix) ? raw.slice(sessionPrefix.length) : raw;
  const cleaned=input.replace(/\/?(?:[?#][^\s]*)?$/, "");
  if (isDsh) return /^[\w-][\w.:-]{0,199}$/.test(cleaned) ? cleaned : undefined;
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cleaned) ? cleaned.toLowerCase() : undefined;
}
export function sessionAddress(id: string) { return sessionPrefix + id; }


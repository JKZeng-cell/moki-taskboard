import { msg, uiLocale } from "./i18n.ts";
import type { Run } from "../types.ts";
import { formatDuration, summarizeUsage } from "../usage.ts";

export function Usage({ runs, title }: { runs: Run[]; title: string }) {
  const { count, reported, tokens, input, output, timed, estimated, elapsed } = summarizeUsage(runs);
  return <section className="usage" aria-label={title}>
    <h4>{title}<small>{count} {msg("次执行")}</small></h4>
    <dl>
      <div><dt>{msg("已记录 Token")}</dt><dd>{reported || !count ? tokens.toLocaleString(uiLocale()) : msg("暂无回执")}</dd></div>
      <div><dt>{msg("累计耗时")}</dt><dd>{timed || !count ? formatDuration(elapsed, uiLocale()) : msg("待核对")}</dd></div>
    </dl>
    {reported > 0 && <p>{msg("输入")} {input.toLocaleString(uiLocale())} {msg("· 输出")} {output.toLocaleString(uiLocale())}</p>}
    {count > reported && <p>{count - reported} {msg("次执行尚无用量回执")}</p>}
    {estimated > 0 && <p>{estimated} {msg("次耗时按运行时间估算")}</p>}
    {count > timed && <p>{count - timed} {msg("次执行的耗时待核对")}</p>}
  </section>;
}

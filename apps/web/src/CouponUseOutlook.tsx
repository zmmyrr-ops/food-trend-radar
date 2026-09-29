export type UseOutlook = {
  evidence_status: string;
  until: string;
  has_explicit_exclusion: boolean;
  fully_excluded: boolean;
  days: {
    date: string;
    weekday: string;
    holiday: string | null;
    status: string;
    reasons: string[];
  }[];
  time_windows: { start: string; end: string; overnight: boolean }[];
  unparsed_dates: string[];
  unparsed_times: string[];
  purchase_relative_days: number | null;
  caveat: string;
};
export function CouponUseOutlook({ data }: { data: UseOutlook | undefined }) {
  if (!data) return null;
  const excluded = data.days.filter((d) => d.status === "explicitly_excluded");
  return (
    <div className="use-outlook">
      <p>
        <strong>未来 72 小时使用限制：</strong>
        {data.evidence_status !== "current"
          ? "当前规则证据缺失或过期"
          : data.fully_excluded
            ? "整个观察窗口均命中明确禁用日期"
            : excluded.length
              ? excluded.map((d) => `${d.date}（${d.weekday}）禁用`).join("、")
              : "未识别到明确禁用日期，可用性仍待核验"}
        。
      </p>
      <details>
        <summary>查看日期、时段及原文依据</summary>
        <ul>
          {data.days.map((d) => (
            <li key={d.date}>
              {d.date} {d.weekday}
              {d.holiday ? ` · ${d.holiday}` : ""}：
              {d.status === "explicitly_excluded" ? "明确禁用" : "未确认可用"}
              {d.reasons.map((r) => (
                <p key={r}>条款：{r}</p>
              ))}
            </li>
          ))}
        </ul>
        {data.time_windows.length > 0 && (
          <p>
            条款列示时段：
            {data.time_windows
              .map((w) => `${w.start}—${w.end}${w.overnight ? "（跨日）" : ""}`)
              .join("、")}
            ，适用日期与例外仍需核验。
          </p>
        )}
        {data.purchase_relative_days !== null && (
          <p>
            购买后 {data.purchase_relative_days}{" "}
            天内有效；不从采集时间计算到期。
          </p>
        )}
        {[...data.unparsed_dates, ...data.unparsed_times].length > 0 && (
          <p>
            未自动判定的条款：
            {[...data.unparsed_dates, ...data.unparsed_times].join("；")}
          </p>
        )}
        <small>{data.caveat}</small>
      </details>
    </div>
  );
}

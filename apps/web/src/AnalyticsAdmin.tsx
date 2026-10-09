import { useEffect, useState } from "react";
import { visitRequest } from "./VisitPlans";
import "./analytics.css";

function eventLabel(name: string) {
  const labels: Record<string, string> = {
    page_view: "页面访问",
    coupon_search: "搜索券",
    coupon_filter: "筛选券",
    coupon_sort: "券排序",
    auth: "账号",
    member: "积分与邀请",
    mini: "小程序",
    coupons: "券详情",
    "coupon-media": "网络素材",
    "video-projects": "视频制作",
    "video-assets": "上传素材",
    "visit-plans": "探店计划",
    "visit-stores": "计划店铺",
    maps: "地图",
    "shop-reports": "品牌上报",
    "brand-subscriptions": "品牌订阅",
    "brand-blacklist": "品牌黑名单",
    "brand-boost": "加速刷新",
    "studio-copy": "文案创作",
    "topic-plays": "热门话题",
    "ai-recommendations": "AI精选",
    login: "登录",
    register: "注册",
    logout: "退出",
    password: "修改密码",
    preview: "预览",
    export: "导出",
    generate: "生成",
    render: "制作",
    download: "下载",
    text: "视频文案",
    review: "审核",
    complete: "完结",
    read: "已读",
    messages: "消息",
    summary: "券信息",
    analyze: "开始制作",
    cancel: "取消",
    invitation: "邀请码",
    "daily-login": "每日奖励",
    sms: "验证码",
    titles: "标题",
    topics: "话题",
    video: "视频结果",
    materials: "素材结果",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
    preview_ready: "预览完成",
    completed: "制作完成",
    POST: "提交",
    GET: "查看",
    PATCH: "修改",
    DELETE: "删除",
    PUT: "更新",
  };
  return name
    .split(".")
    .map((x) => labels[x] || x)
    .join(" · ");
}
export function AnalyticsAdmin() {
  const [days, setDays] = useState(7),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void visitRequest(`analytics?days=${days}`)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [days, revision]);
  return (
    <section className="analytics-admin">
      <div className="section-title">
        <div>
          <h1>业务统计</h1>
          <p>按北京时间统计 · 埋点异步入库，约 30 秒后可见 · 保留 90 天</p>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "今天" : `最近 ${n} 天`}
            </option>
          ))}
        </select>
        <button onClick={() => setRevision((x) => x + 1)}>刷新</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <div className="analytics-metrics">
            {[
              ["页面访问 PV", data.overview.pv],
              ["访问用户 UV", data.overview.uv],
              ["业务请求", data.overview.operations],
              ["失败请求", data.overview.failures],
              ["消耗积分", data.points.spent],
              ["发放积分", data.points.granted],
            ].map(([label, value]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
          <p className="muted">
            UV
            按已登录账号去重；积分以实际账本为准，包含退款与管理员赠送。业务请求成功表示接口受理成功，不等于异步视频已制作完成。统计从功能上线后开始，积分支持已有历史账本。
          </p>
          <h2>每日访问</h2>
          <div className="analytics-table">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>PV</th>
                  <th>UV</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((x: any) => (
                  <tr key={x.day}>
                    <td>{x.day}</td>
                    <td>{x.pv}</td>
                    <td>{x.uv}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>核心路径与页面</h2>
          <div className="analytics-table">
            <table>
              <thead>
                <tr>
                  <th>事件</th>
                  <th>页面 / 模块</th>
                  <th>端</th>
                  <th>次数</th>
                  <th>人数</th>
                  <th>失败</th>
                  <th>平均耗时 ms</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((x: any) => (
                  <tr key={`${x.name}:${x.page}:${x.channel}`}>
                    <td>{eventLabel(x.name)}</td>
                    <td>{x.page}</td>
                    <td>{x.channel}</td>
                    <td>{x.count}</td>
                    <td>{x.users}</td>
                    <td>{x.failures}</td>
                    <td>{x.avg_ms ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>积分用途汇总</h2>
          <div className="analytics-table">
            <table>
              <thead>
                <tr>
                  <th>用途</th>
                  <th>次数</th>
                  <th>净变动</th>
                </tr>
              </thead>
              <tbody>
                {data.pointReasons.map((x: any) => (
                  <tr key={x.reason}>
                    <td>{x.reason}</td>
                    <td>{x.count}</td>
                    <td>{x.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>最近 100 条积分明细</h2>
          <div className="analytics-table">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用户 ID</th>
                  <th>用途</th>
                  <th>积分</th>
                  <th>可见性</th>
                </tr>
              </thead>
              <tbody>
                {data.pointDetails.map((x: any, i: number) => (
                  <tr key={`${x.created_at}:${i}`}>
                    <td>{new Date(x.created_at).toLocaleString("zh-CN")}</td>
                    <td>{x.owner_id}</td>
                    <td>{x.reason}</td>
                    <td>{x.amount}</td>
                    <td>{x.hidden ? "仅管理员" : "用户可见"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            待入库 {data.queued} · 本次运行超限丢弃 {data.dropped}
          </p>
        </>
      )}
    </section>
  );
}

import { useState } from "react";
import { appUrl } from "./app-url";
import { Points } from "./Points";
import "./user-guide.css";

const chapters = [
  {
    id: "coupons",
    title: "发现与筛选优惠券",
    intro: "先选合适的券，再决定去哪里、拍什么。",
    href: "/?tab=radar",
    action: "去选券",
    articles: [
      {
        title: "如何找到想要的券？",
        steps: [
          "进入美食发现或游玩灵感，输入品牌名或券关键词。",
          "默认查看全部券；可用分类及优先券、增长加快、新上筛选缩小范围。",
          "点击优先分或热度增速切换排序；新上默认按首次发现时间从新到旧排列。",
          "查看售价、关联店铺和使用规则，点击店铺位置查看地图。",
        ],
        note: "优先分是筛选参考，不代表实际销量或成交保证。下单前请核对门店、预约、有效期及其他限制。",
      },
      {
        title: "优先券、增长加快和新上有什么区别？",
        steps: [
          "优先券：综合优惠、销售趋势等条件筛选出的候选券。",
          "增长加快：已有连续数据支持增长速度提升的券。",
          "新上：系统首次有效发现后24小时内的券，不等于商家刚刚发布。",
        ],
      },
      {
        title: "如何加速刷新某个品牌？",
        steps: [
          "点击加速刷新品牌，搜索并选择品牌。",
          "确认积分消耗后提交，等待队列依次处理。",
          "刷新成功后，在消息通知查看结果。",
        ],
        note: "消耗20积分，每人每天最多2次；品牌半小时内已刷新时会提示已经是最新数据。",
      },
      {
        title: "AI精选怎么用？",
        steps: [
          "进入选券页面的AI精选，确认消耗后发起分析。",
          "阅读品牌、客群、优惠及环境因素对券销售潜力的判断，结合实际使用规则选券。",
        ],
        note: "分析结果供选券参考，不保证一定好卖。",
      },
    ],
  },
  {
    id: "plans",
    title: "探店计划",
    intro: "按店铺安排日期和路线，从计划开始制作视频。",
    href: "/?tab=workspace&section=plans",
    action: "打开我的计划",
    articles: [
      {
        title: "从券加入计划",
        steps: [
          "点击券上的加入探店计划，选择或创建计划并填写日期。",
          "核对店铺名称与地址，搜索地图位置，选择正确门店或在地图上选点。",
          "保存店铺后，可前往计划查看各店铺的位置。",
        ],
        note: "加入的是店铺，不是单张券。已加入的券可直接前往对应计划。",
      },
      {
        title: "自定义店铺和完结计划",
        steps: [
          "在我的工作台 → 探店计划中新增计划，也可以手动添加店铺名称和位置。",
          "出发前调整店铺信息或顺序，通过地图规划线路。",
          "行程完成后完结计划，释放关联，方便下次再探。",
        ],
        note: "已完结计划不可编辑，店铺不再提供制作视频入口；已有视频可到我的视频查看。",
      },
    ],
  },
  {
    id: "studio",
    title: "素材与视频制作",
    intro: "选择素材、设置成片，再生成和导出。",
    href: "/?tab=workspace&section=plans",
    action: "从计划进入制作",
    articles: [
      {
        title: "如何开始制作视频？",
        steps: [
          "进入未完结计划，在对应店铺点击制作探店视频，新窗口打开制作页。",
          "获取网络素材或主动上传素材，勾选需要使用的内容；制作要求至少4个、最多40个素材。",
          "拖动时长滑块选择15—40秒，实际成片时长可能略有差异。",
          "按需选择视频稿、字幕、语音口播，确认拥有素材使用权限后点击开始制作。",
          "阅读积分确认弹窗后提交，等待生成，完成后预览或导出。",
        ],
        note: "网络视频仅供参考，未经授权不得用于创作或传播。素材通过筛选不代表已获得使用授权。",
      },
      {
        title: "如何补充和管理素材？",
        steps: [
          "网络素材可点击再获取一些持续补充；自己的内容放在上传素材中。",
          "使用全选、取消全选调整选用范围，批量下载可将选中素材打包保存。",
          "查看通过、未通过或待分析标识；审核通过不代表每个片段都会出现在成片中。",
        ],
      },
      {
        title: "视频文案、标题和话题怎么生成？",
        steps: [
          "先获取网络图片素材，再点击智能生成视频文案，生成可复制的口播文案参考。",
          "标题模块一次生成3个标题，可复制或换一批。",
          "话题模块获取候选话题，勾选后再复制，格式为 #话题1 #话题2。",
          "勾选的话题会锁定，换一批时保留。",
        ],
        note: "生成内容请核对实际画面、价格和门店信息后再使用。",
      },
      {
        title: "如何设置口播和字幕？",
        steps: [
          "勾选视频稿后，可按需开启画面字幕或语音口播。",
          "口播可选择音色并试听；字幕可调整字体、字号、位置和边框。",
          "不需要视频稿时取消勾选，字幕和口播需依赖视频稿；目前不提供背景音乐选项。",
        ],
      },
      {
        title: "生成失败或视频过期怎么办？",
        steps: [
          "先阅读失败提示，检查素材是否有效、数量是否足够以及账号积分余额。",
          "修改素材或配置后再尝试制作，留意确认弹窗的费用。",
          "在我的工作台 → 我的视频查看记录、下载成片或删除不需要的视频。",
          "过期状态以列表提示为准，需要保留的成片请及时下载。",
        ],
        note: "如仍无法制作，请在我要反馈中提供品牌名、操作步骤和错误提示；扣款情况以积分明细为准。",
      },
    ],
  },
  {
    id: "brands",
    title: "订阅、黑名单与通知",
    intro: "保留关注的品牌，减少不想看的内容。",
    href: "/?tab=workspace&section=subscriptions",
    action: "管理品牌订阅",
    articles: [
      {
        title: "订阅品牌和查看提醒",
        steps: [
          "打开我的工作台 → 品牌订阅，搜索并订阅品牌。",
          "有新券或符合条件的热度变化时，在消息通知查看提醒。",
          "如需系统通知，请允许浏览器通知权限；没有系统通知时也可查看站内消息。",
          "点击消息查看相关品牌，读完后可以一键清空消息。",
        ],
      },
      {
        title: "如何屏蔽不感兴趣的品牌？",
        steps: [
          "进入我的工作台 → 品牌黑名单，搜索品牌并加入。",
          "需要恢复推荐时，在黑名单列表移除对应品牌。",
        ],
        note: "黑名单是个人偏好，不会删除品牌或影响其他用户。",
      },
    ],
  },
  {
    id: "points",
    title: "积分与账号",
    intro: "操作前看费用，操作后查明细。",
    href: "/?tab=workspace&section=member",
    action: "查看积分与邀请",
    articles: [
      {
        title: "积分在哪里查看和获得？",
        steps: [
          "页面右上角显示可用积分，点击进入积分与邀请。",
          "每天首次登录可获得20积分，发放结果会弹窗提示。",
          "生成自己的邀请码，成功邀请新用户注册可获得100积分。",
          "上报缺失品牌，经审核收录可获得20积分，同一用户同一品牌仅奖励一次。",
          "在积分明细查看积分变化，操作前以费用确认弹窗为准。",
        ],
      },
      {
        title: "注册、登录和修改密码",
        steps: [
          "已有账号使用手机号和登录密码登录。",
          "新用户在注册页填写手机号、短信验证码、邀请码和登录密码。",
          "在我的工作台 → 积分与邀请中管理账号安全、修改密码及查看邀请记录。",
        ],
        note: "请勿把登录密码或短信验证码作为反馈内容提交。",
      },
    ],
  },
  {
    id: "feedback",
    title: "上报店铺与问题反馈",
    intro: "没有想找的店，或使用不顺畅，都可以告诉我们。",
    href: "/?tab=reports",
    action: "前往我要反馈",
    articles: [
      {
        title: "上报缺失的店铺",
        steps: [
          "进入我要反馈 → 店铺上报。",
          "填写店铺名称、地址和分类，可补充链接或说明。",
          "提交后在页面查看审核结果；符合奖励规则的收录会发放积分。",
        ],
      },
      {
        title: "反馈异常和改进建议",
        steps: [
          "进入我要反馈 → 其他问题反馈。",
          "描述问题出现的位置、操作步骤、品牌名和错误提示，提交反馈。",
          "在我的问题反馈查看处理状态和管理员回复。",
        ],
        note: "普通用户只能看到自己提交的问题。",
      },
    ],
  },
];
const costs = [
  ["获取／重置网络素材", 10],
  ["再获取一些素材", 5],
  ["智能生成视频文案", 5],
  ["生成／更换标题", 5],
  ["查找／更换话题", 5],
  ["开始／重新制作视频", 50],
  ["AI精选", 30],
  ["加速刷新品牌", 20],
] as const;
export function UserGuide() {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const visible = chapters
    .map((c) => ({
      ...c,
      articles: c.articles.filter((a) =>
        [c.title, a.title, ...a.steps, "note" in a ? a.note : ""]
          .join(" ")
          .toLowerCase()
          .includes(term),
      ),
    }))
    .filter((c) => c.articles.length);
  return (
    <section className="user-guide">
      <div className="guide-intro">
        <span className="guide-kicker">探好店 · 使用指南</span>
        <h1>从发现好券，到完成创作</h1>
        <p>第一次使用，从下面三步开始；遇到具体问题，也可以直接搜索。</p>
        <label className="guide-search">
          搜索使用方法
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索：积分、字幕、订阅、加入计划…"
          />
        </label>
      </div>
      {!term && (
        <div className="guide-start">
          {[
            ["01", "选一张合适的券", "/?tab=radar"],
            ["02", "加入探店计划", "/?tab=workspace&section=plans"],
            ["03", "从计划店铺制作视频", "/?tab=workspace&section=plans"],
          ].map(([n, t, href]) => (
            <a href={appUrl(href)} key={n}>
              <small>{n}</small>
              <span>{t}</span>
              <b aria-hidden="true">→</b>
            </a>
          ))}
        </div>
      )}
      <div className="guide-layout">
        <div className="guide-directory" aria-label="指南目录">
          <strong>使用目录</strong>
          {visible.map((c) => (
            <a href={`#guide-${c.id}`} key={c.id}>
              {c.title}
            </a>
          ))}
          <a href={appUrl("/?tab=reports")}>仍需帮助？我要反馈 →</a>
        </div>
        <div className="guide-content">
          {visible.map((c) => (
            <section id={`guide-${c.id}`} className="guide-chapter" key={c.id}>
              <div className="guide-chapter-title">
                <div>
                  <h2>{c.title}</h2>
                  <p>{c.intro}</p>
                </div>
                <a href={appUrl(c.href)}>{c.action} →</a>
              </div>
              {c.articles.map((a) => (
                <details
                  className="guide-article"
                  key={a.title}
                  open={term ? true : undefined}
                >
                  <summary>{a.title}</summary>
                  <ol>
                    {a.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  {"note" in a && a.note && (
                    <p className="guide-note">{a.note}</p>
                  )}
                </details>
              ))}
              {c.id === "points" && (
                <div className="guide-costs">
                  <h3>常用操作积分</h3>
                  <p>下列为当前费用，提交前请核对页面确认弹窗。</p>
                  {costs.map(([label, amount]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <Points amount={amount} cost />
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
          {!visible.length && (
            <div className="guide-empty">
              <h2>没有找到相关指引</h2>
              <p>试试“视频”“积分”“计划”等关键词，或通过我要反馈告诉我们。</p>
              <button onClick={() => setQuery("")}>查看全部指南</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

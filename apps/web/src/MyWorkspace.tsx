import "./workspace.css";
import type { Brand } from "@radar/contracts";
import { useState } from "react";
import { BrandBlacklist } from "./BrandBlacklist";
import { BrandSubscriptions } from "./BrandSubscriptions";
import { Membership } from "./Membership";
import { VideoLibrary } from "./VideoLibrary";
import { VisitPlans } from "./VisitPlans";

const sections = [
  ["member", "积分与邀请", "积分、邀请好友与账号安全"],
  ["plans", "探店计划", "安排店铺与路线"],
  ["videos", "我的视频", "查看成片与制作记录"],
  ["subscriptions", "品牌订阅", "管理订阅与通知"],
  ["blacklist", "品牌黑名单", "管理不想推荐的品牌"],
] as const;
export function MyWorkspace({ brands }: { brands: Brand[] }) {
  const [section, setSection] = useState(() => {
    const q = new URLSearchParams(location.search);
    const value = q.get("section") || q.get("tab");
    return sections.some(([key]) => key === value) ? value! : "plans";
  });
  const [videoChannel, setVideoChannel] = useState<"all" | "food" | "leisure">(
    "all",
  );
  function select(next: string) {
    setSection(next);
    const url = new URL(location.href);
    url.searchParams.set("tab", "workspace");
    url.searchParams.set("section", next);
    window.history.replaceState({}, "", url);
  }
  return (
    <section className="my-workspace" aria-label="我的工作台">
      <nav className="personal-tabs" aria-label="工作台分类">
        {sections.map(([key, label]) => (
          <button
            key={key}
            aria-pressed={section === key}
            onClick={() => select(key)}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {key === "plans" ? (
                <>
                  <rect x="4" y="5" width="16" height="16" rx="3" />
                  <path d="M8 3v4m8-4v4M4 11h16m-11 5h2m3 0h2" />
                </>
              ) : key === "videos" ? (
                <>
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <path d="m10 8 6 4-6 4Z" />
                </>
              ) : key === "subscriptions" ? (
                <>
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" />
                </>
              ) : key === "member" ? (
                <>
                  <circle cx="12" cy="12" r="9" />
                  <path d="m12 7 1.5 3 3.5.5-2.5 2.5.5 3.5-3-1.5-3 1.5.5-3.5L7 10.5l3.5-.5Z" />
                </>
              ) : (
                <>
                  <path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6Z" />
                  <path d="M9 12h6" />
                </>
              )}
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className={`workspace-content workspace-section-${section}`}>
        {section === "member" && <Membership />}
        {section === "plans" && <VisitPlans />}
        {section === "videos" && (
          <>
            <div className="workspace-video-heading">
              <h2>我的视频</h2>
              <div className="channel-switch" aria-label="视频频道筛选">
                {(["all", "food", "leisure"] as const).map((c) => (
                  <button
                    key={c}
                    aria-pressed={videoChannel === c}
                    onClick={() => setVideoChannel(c)}
                  >
                    {c === "all" ? "全部" : c === "food" ? "美食" : "游玩"}
                  </button>
                ))}
              </div>
            </div>
            <VideoLibrary channel={videoChannel} brands={brands} />
          </>
        )}
        {section === "subscriptions" && <BrandSubscriptions mode="manage" />}
        {section === "blacklist" && <BrandBlacklist />}
      </div>
    </section>
  );
}

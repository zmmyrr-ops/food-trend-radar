import type { Brand } from "@radar/contracts";
import { useState } from "react";
import { BrandBlacklist } from "./BrandBlacklist";
import { VideoLibrary } from "./VideoLibrary";
import { VisitPlans } from "./VisitPlans";

const sections = [
  ["plans", "探店计划", "安排店铺与路线"],
  ["videos", "我的视频", "查看成片与制作记录"],
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
      <header className="workspace-heading">
        <h1>我的工作台</h1>
        <p>计划、作品和推荐偏好，都在这里。</p>
      </header>
      <nav className="workspace-tabs" aria-label="工作台分类">
        {sections.map(([key, label, detail]) => (
          <button
            key={key}
            aria-pressed={section === key}
            onClick={() => select(key)}
          >
            <strong>{label}</strong>
            <small>{detail}</small>
          </button>
        ))}
      </nav>
      <div className="workspace-content">
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
        {section === "blacklist" && <BrandBlacklist />}
      </div>
    </section>
  );
}

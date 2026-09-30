type ProgressProject = {
  state: string;
  progress: string;
};
/** Stage-based estimate: only completed output reaches 100%. */
export function videoProgress(project: ProgressProject) {
  const match = project.progress.match(/(\d+)\s*\/\s*(\d+)/);
  const total = Math.max(1, Number(match?.[2] || 1));
  const current = Math.min(total, Math.max(1, Number(match?.[1] || 1)));
  const fraction = (current - 1) / total;
  switch (project.state) {
    case "preparing":
    case "analyzing":
      return {
        percent: Math.round(5 + fraction * 65),
        title: "正在智能制作视频",
        detail: match
          ? `正在分析第 ${current}/${total} 个视频`
          : "正在准备素材",
      };
    case "planning":
      return {
        percent: 72,
        title: "正在智能制作视频",
        detail: "正在编排精彩镜头",
      };
    case "rendering_preview":
    case "rendering_export":
      return {
        percent: project.progress.includes("云端")
          ? 98
          : match
            ? Math.round(78 + (current / total) * 17)
            : 78,
        title: "正在智能制作视频",
        detail: project.progress.includes("云端")
          ? "正在保存成片"
          : "正在合成视频",
      };
    case "preview_ready":
      return {
        percent: 100,
        title: "视频预览已就绪",
        detail: "可以预览、调整镜头或导出成片",
      };
    case "completed":
      return {
        percent: 100,
        title: "视频制作完成",
        detail: "成片已就绪，可以下载",
      };
    case "edited":
      return {
        percent: null,
        title: "镜头已调整",
        detail: "更新预览后即可查看最新效果",
      };
    case "failed":
    case "interrupted":
    case "cancelled":
      return {
        percent: null,
        title: "视频制作已暂停",
        detail: "可重新尝试制作",
      };
    default:
      return { percent: 0, title: "正在智能制作视频", detail: "等待开始制作" };
  }
}

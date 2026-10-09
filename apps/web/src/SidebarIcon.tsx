import "./sidebar-icons.css";

type IconName =
  | "food"
  | "leisure"
  | "workspace"
  | "brands"
  | "feedback"
  | "guide";
const paths: Record<IconName, React.ReactNode> = {
  food: (
    <>
      <path d="M4 3v5a2 2 0 0 0 4 0V3M6 3v18M16 3v18M16 3c-4 3-4 8 0 8h3V3" />
    </>
  ),
  leisure: (
    <>
      <circle cx="12" cy="10" r="7" />
      <circle cx="12" cy="10" r="2" />
      <path d="M12 3v5m0 4v5M5 10h5m4 0h5M7 5l3.5 3.5M13.5 11.5 17 15M17 5l-3.5 3.5M10.5 11.5 7 15M10 17l-2 4m6-4 2 4M6 21h12" />
    </>
  ),
  workspace: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 9h18M9 9v11M13 13h4M13 16h3" />
    </>
  ),
  brands: (
    <>
      <path d="m4 3-2 5v1a3 3 0 0 0 5 2 3 3 0 0 0 5 0 3 3 0 0 0 5 0 3 3 0 0 0 5-2V8l-2-5H4ZM4 12v9h16v-9M9 21v-6h6v6M7 8l1-5m4 5V3m5 5-1-5" />
    </>
  ),
  feedback: (
    <>
      <path d="M8 18H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-5l-5 3v-3Z" />
      <path d="M7 8h10M7 12h7" />
    </>
  ),
  guide: (
    <>
      <path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v15M6 8l3 1M6 12l3 1m6-4 3-1m-3 5 3-1" />
    </>
  ),
};
export function SidebarIcon({ name }: { name: IconName }) {
  return (
    <span className="sidebar-menu-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {paths[name]}
      </svg>
    </span>
  );
}

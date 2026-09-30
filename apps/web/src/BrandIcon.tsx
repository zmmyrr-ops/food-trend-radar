import { useState } from "react";
import { appUrl } from "./app-url";
export function BrandIcon({
  name,
  url,
}: {
  name: string;
  url?: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="brand-icon" title={name}>
      {url && failed !== url ? (
        <img
          src={appUrl(url)}
          alt={`${name}图标`}
          loading="lazy"
          onError={() => setFailed(url)}
        />
      ) : (
        <span aria-hidden="true">{Array.from(name).slice(0, 2).join("")}</span>
      )}
    </span>
  );
}

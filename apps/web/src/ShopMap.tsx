import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { appFetch } from "./app-url";

type Point = { name: string; lat: number; lng: number; address?: string };
let sdk: Promise<any> | undefined;
export function loadMap(): Promise<any> {
  if (!sdk)
    sdk = (async () => {
      const r = await appFetch("/api/v3/maps/config");
      const c = await r.json();
      if (!r.ok || !c.key) throw Error("地图配置暂不可用");
      const w = window as any;
      w._AMapSecurityConfig = {
        serviceHost: `${location.origin}/_AMapService`,
      };
      if (w.AMap) return w.AMap;
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        const timer = setTimeout(() => {
          script.remove();
          reject(Error("地图加载超时，请重试"));
        }, 15000);
        script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(c.key)}&plugin=AMap.PlaceSearch,AMap.Driving`;
        script.onload = () => {
          clearTimeout(timer);
          w.AMap ? resolve(w.AMap) : reject(Error("地图初始化失败"));
        };
        script.onerror = () => {
          clearTimeout(timer);
          script.remove();
          reject(Error("地图加载失败"));
        };
        document.head.appendChild(script);
      });
    })().catch((e) => {
      sdk = undefined;
      throw e;
    });
  return sdk;
}
const cache = new Map<string, Point[]>();
let lastSearch = 0;
export async function searchPlaces(q: string): Promise<Point[]> {
  const saved = cache.get(q);
  if (saved) return saved;
  if (Date.now() - lastSearch < 1500) throw Error("请稍等两秒再搜索");
  lastSearch = Date.now();
  const A = await loadMap();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("位置搜索超时，请重试")),
      12000,
    );
    new A.PlaceSearch({ city: "上海", citylimit: true, pageSize: 8 }).search(
      q,
      (status: string, data: any) => {
        clearTimeout(timer);
        if (status === "no_data") {
          resolve([]);
          return;
        }
        if (status !== "complete") {
          reject(Error("高德位置搜索失败，请检查地图配置后重试"));
          return;
        }
        const points = (data.poiList?.pois || [])
          .filter((p: any) => p.location)
          .map((p: any) => ({
            name: p.name,
            address: `${p.pname || ""}${p.cityname && p.cityname !== p.pname ? p.cityname : ""}${p.adname || ""}${typeof p.address === "string" ? p.address : ""}`,
            lat: p.location.lat,
            lng: p.location.lng,
          }));
        cache.set(q, points);
        resolve(points);
      },
    );
  });
}
export function VisitMap({
  stores,
  onPick,
}: {
  stores: Point[];
  onPick?: (lat: number, lng: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    map = useRef<any>(null),
    A = useRef<any>(null),
    pick = useRef(onPick),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [routing, setRouting] = useState(false);
  pick.current = onPick;
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError("");
    void loadMap()
      .then((api) => {
        if (cancelled || !root.current) return;
        A.current = api;
        map.current = new api.Map(root.current, {
          zoom: 12,
          center: [121.4737, 31.2304],
          viewMode: "2D",
        });
        map.current.on("click", (e: any) =>
          pick.current?.(e.lnglat.lat, e.lnglat.lng),
        );
        setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      map.current?.destroy();
      map.current = null;
    };
  }, [retry]);
  useEffect(() => {
    if (!ready || !map.current) return;
    const m = map.current,
      api = A.current;
    m.clearMap();
    const markers = stores.map((s, i) => {
      const node = document.createElement("div");
      node.className = "visit-pin";
      node.textContent = String(i + 1);
      return new api.Marker({
        position: [s.lng, s.lat],
        content: node,
        title: s.name,
        anchor: "bottom-center",
      });
    });
    m.add(markers);
    if (markers.length) m.setFitView(markers, false, [45, 45, 45, 45], 16);
    if (markers.length > 1)
      m.add(
        new api.Polyline({
          path: stores.map((s) => [s.lng, s.lat]),
          strokeColor: "#4388ed",
          strokeStyle: "dashed",
          strokeWeight: 2,
        }),
      );
  }, [stores, ready]);
  async function route() {
    if (stores.length < 2 || !map.current) return;
    setRouting(true);
    setError("");
    const a = stores[0],
      b = stores[stores.length - 1];
    let timer: ReturnType<typeof setTimeout>;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(Error("路线规划超时")), 15000);
        new A.current.Driving({ map: map.current, hideMarkers: true }).search(
          [a.lng, a.lat],
          [b.lng, b.lat],
          { waypoints: stores.slice(1, -1).map((s) => [s.lng, s.lat]) },
          (status: string) =>
            status === "complete"
              ? resolve()
              : reject(Error("路线暂不可用，请调整店铺顺序后重试")),
        );
      });
    } catch (e) {
      setError(String(e));
    } finally {
      clearTimeout(timer!);
      setRouting(false);
    }
  }
  return (
    <div>
      <div
        className="visit-map"
        ref={root}
        aria-label={onPick ? "点击地图选择店铺位置" : "高德店铺地图"}
      />
      {!ready && !error && <p className="muted">地图加载中…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setRetry((n) => n + 1)}>重试地图</button>
        </p>
      )}
      {stores.length > 1 && (
        <div className="visit-actions">
          <button
            type="button"
            disabled={!ready || routing || stores.length > 18}
            onClick={() => void route()}
          >
            {routing ? "规划中…" : "按顺序规划驾车路线"}
          </button>
          <span className="muted">
            可上下调整店铺顺序
            {stores.length > 18 ? "；单次驾车路线最多18站" : ""}
          </span>
        </div>
      )}
    </div>
  );
}
export function ShopLocation({
  name,
  address,
  lat,
  lng,
}: {
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}) {
  const [open, setOpen] = useState(false),
    [points, setPoints] = useState<Point[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  async function show() {
    setOpen(true);
    setError("");
    if (lat !== undefined && lng !== undefined) {
      setPoints([{ name, address, lat, lng }]);
      return;
    }
    setLoading(true);
    try {
      const found = await searchPlaces(name);
      setPoints(found);
      if (!found.length) setError("未找到该店铺位置，请核对店名和地址。");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="shop-location-link"
        onClick={() => void show()}
      >
        {name} <LocationIcon />
      </button>
      {open &&
        createPortal(
          <div className="visit-modal-backdrop">
            <section
              role="dialog"
              aria-modal="true"
              aria-label="店铺地图"
              className="visit-modal"
            >
              <div className="visit-title">
                <h2>{name}</h2>
                <button onClick={() => setOpen(false)} aria-label="关闭地图">
                  ×
                </button>
              </div>
              <p>{address || "平台未返回地址"}</p>
              <VisitMap stores={points} />
              {loading && <p role="status">正在查找门店位置…</p>}
              {error && (
                <p role="alert">
                  {error} <button onClick={() => void show()}>重新查找</button>
                </p>
              )}
              {points.length > 1 && (
                <p className="muted">
                  找到多个匹配位置，请选择与你的店铺地址一致的门店。
                </p>
              )}
              {points.map((p, i) => (
                <button
                  className="place-result"
                  key={`${p.lat}-${p.lng}`}
                  onClick={() => setPoints([p])}
                >
                  {i + 1}. {p.name} · {p.address}
                </button>
              ))}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
export function LocationIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

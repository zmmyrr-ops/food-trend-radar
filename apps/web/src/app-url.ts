/** Resolve API and download paths relative to the configured deployment prefix. */
export function appUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}
export async function appFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(appUrl(path), init);
  if (response.status === 401 && !path.startsWith("/api/auth/"))
    window.dispatchEvent(new Event("account-expired"));
  if (init?.method && init.method !== "GET")
    window.dispatchEvent(new Event("points-changed"));
  return response;
}

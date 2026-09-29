/** Resolve API and download paths relative to the configured deployment prefix. */
export function appUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}
export function appFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(appUrl(path), init);
}

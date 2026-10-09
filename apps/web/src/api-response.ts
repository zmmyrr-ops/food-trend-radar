/** Never show gateway HTML or JSON parser internals to the user. */
export async function readApiResponse(response: Response) {
  const fallback =
    response.status === 401
      ? "登录已失效，请重新登录"
      : response.status === 403
        ? "请求被拒绝，请刷新页面后重试"
        : response.status === 429
          ? "操作过于频繁，请稍后重试"
          : response.status >= 500
            ? "服务暂时不可用，请稍后重试"
            : "服务响应异常，请稍后重试";
  if (response.ok && response.status === 204) return {};
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(fallback);
  }
  if (!response.ok)
    throw Error(
      typeof data?.error?.message === "string" ? data.error.message : fallback,
    );
  if (!data || typeof data !== "object") throw Error(fallback);
  return data;
}

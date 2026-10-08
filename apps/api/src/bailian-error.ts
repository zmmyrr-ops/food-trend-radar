/** Keep provider diagnostics useful without exposing echoed prompts or credentials. */
export function bailianError(status: number, body: unknown) {
  const data = body as {
    error?: { code?: unknown; type?: unknown };
    request_id?: unknown;
  } | null;
  const rawCode = data?.error?.code ?? data?.error?.type;
  const code =
    typeof rawCode === "string" && /^[\w.-]{1,80}$/.test(rawCode)
      ? rawCode
      : "Unknown";
  const requestId =
    typeof data?.request_id === "string" &&
    /^[\w-]{1,100}$/.test(data.request_id)
      ? data.request_id
      : "";
  const accountRejected =
    /^(Arrearage|InvalidApiKey|AccessDenied|Unauthorized)$/i.test(code) ||
    [401, 402, 403].includes(status);
  let message = `智能服务请求失败（HTTP ${status}，${code}），请联系管理员检查服务配置`;
  if (code === "Arrearage" || status === 402)
    message =
      "智能服务账户欠费或余额不足（Arrearage）。请联系管理员检查服务账户，恢复服务后再重试";
  else if ([401, 403].includes(status) || accountRejected)
    message = `智能服务密钥或服务权限不可用（${code}），请检查密钥和服务权限后重试`;
  else if (status === 429) message = `智能服务调用限流（${code}），请稍后重试`;
  else if (status >= 500)
    message = `智能服务服务暂时异常（HTTP ${status}），请稍后重试`;
  return {
    message: message + (requestId ? `；请求编号：${requestId}` : ""),
    accountRejected,
  };
}

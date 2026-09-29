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
  let message = `百炼请求失败（HTTP ${status}，${code}），请联系管理员检查模型配置`;
  if (code === "Arrearage" || status === 402)
    message =
      "百炼账户欠费或余额不足（Arrearage）。请到阿里云「费用与成本」检查账单并充值，恢复服务后再重试";
  else if ([401, 403].includes(status) || accountRejected)
    message = `百炼密钥或模型权限不可用（${code}），请检查密钥和服务权限后重试`;
  else if (status === 429) message = `百炼调用限流（${code}），请稍后重试`;
  else if (status >= 500)
    message = `百炼服务暂时异常（HTTP ${status}），请稍后重试`;
  return {
    message: message + (requestId ? `；请求编号：${requestId}` : ""),
    accountRejected,
  };
}

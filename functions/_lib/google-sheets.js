export async function syncOrderToGoogleSheets({ env, token, order, event }) {
  const endpoint = String(env.GOOGLE_SHEETS_WEBHOOK_URL || "").trim();
  const secret = String(env.GOOGLE_SHEETS_WEBHOOK_SECRET || "").trim();

  if (!endpoint || !secret || !token || !order) {
    return { sent: false, configured: false };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        event: String(event || "order_updated"),
        orderToken: token,
        order
      })
    });

    const responseText = await response.text();
    let result = null;
    try { result = JSON.parse(responseText); } catch (_) {}

    if (!response.ok || !result || result.success !== true) {
      console.error("Google Sheets sync failed:", {
        status: response.status,
        event: String(event || "order_updated"),
        response: responseText.slice(0, 1000)
      });
      return { sent: false, configured: true };
    }

    return { sent: true, configured: true };
  } catch (error) {
    // Ошибка таблицы не должна блокировать создание заказа, оплату или выдачу отчёта.
    console.error("Google Sheets sync error:", {
      event: String(event || "order_updated"),
      message: String(error && error.message || error)
    });
    return { sent: false, configured: true };
  }
}

// В Cloudflare Pages синхронизация выполняется после ответа клиенту,
// чтобы медленный Apps Script не прерывал завершение диагностики.
export function scheduleOrderSync(context, payload) {
  const task = syncOrderToGoogleSheets(payload);
  if (context && typeof context.waitUntil === "function") {
    context.waitUntil(task);
    return;
  }
  return task;
}

export async function syncOrderToGoogleSheets({ env, token, order, event }) {
  const endpoint = String(env.GOOGLE_SHEETS_WEBHOOK_URL || "").trim();
  const secret = String(env.GOOGLE_SHEETS_WEBHOOK_SECRET || "").trim();

  // Интеграция необязательна до настройки Apps Script и секретов Cloudflare.
  if (!endpoint || !secret || !token || !order) {
    return { sent: false, configured: false };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        event: String(event || "order_updated"),
        orderToken: token,
        order
      })
    });

    if (!response.ok) {
      console.error("Google Sheets sync failed:", response.status);
      return { sent: false, configured: true };
    }

    const result = await response.json().catch(() => null);
    if (!result || result.success !== true) {
      console.error("Google Sheets rejected order sync.");
      return { sent: false, configured: true };
    }

    return { sent: true, configured: true };
  } catch (error) {
    // Сбой таблицы не должен блокировать создание заказа, оплату или выдачу отчёта.
    console.error("Google Sheets sync error:", error);
    return { sent: false, configured: true };
  }
}

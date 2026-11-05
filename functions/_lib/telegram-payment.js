export async function sendPaymentTelegramNotification({ env, token, tokenData, amount }) {
  if (tokenData.paymentTelegramSentAt) {
    return { sent: true, alreadySent: true };
  }

  if (!env.TELEGRAM_PAYMENT_BOT_TOKEN || !env.TG_CHAT_ID) {
    console.error("Telegram payment notification is not configured: missing bot token or chat ID.");
    return { sent: false, configured: false };
  }

  const testFiles = {
    "7": "test_7_basic.html", "7_basic": "test_7_basic.html", "7_advanced": "test_7_advanced.html",
    "8": "test_8_basic.html", "8_basic": "test_8_basic.html", "8_advanced": "test_8_advanced.html",
    "9": "test_9_basic.html", "9_basic": "test_9_basic.html", "9_advanced": "test_9_advanced.html",
    "10": "test_10_basic.html", "10_basic": "test_10_basic.html", "10_advanced": "test_10_advanced.html",
    "11": "test_11_basic.html", "11_basic": "test_11_basic.html", "11_advanced": "test_11_advanced.html"
  };
  const testUrl = "https://reshai360.ru/" + (testFiles[tokenData.productKey] || "index.html") + "?token=" + encodeURIComponent(token);
  const money = value => Number(value || 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₽";
  const lines = [
    "💳 ОПЛАТА ПОДТВЕРЖДЕНА — РЕШАЙ360",
    "Имя: " + (tokenData.studentName || "Не указано"),
    "Email: " + (tokenData.email || "Не указан"),
    "Диагностика: " + (tokenData.productTitle || tokenData.productKey || "Не указана"),
    "Стоимость: " + money(tokenData.displayAmount ?? tokenData.listPrice ?? amount),
    tokenData.promoCode ? "Введённый промокод: " + tokenData.promoCode : "Промокод: не вводили",
    tokenData.promoCode ? "Скидка: " + money(tokenData.discountAmount) + " (" + Number(tokenData.discountPercent || 0).toLocaleString("ru-RU") + "%)" : "",
    "Ссылка на диагностику: " + testUrl
  ].filter(Boolean);

  try {
    const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_PAYMENT_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text: lines.join("\n"),
        disable_web_page_preview: true
      })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      console.error("Telegram payment notification error:", response.status, result?.description || "Invalid Telegram API response");
      return { sent: false, configured: true };
    }

    tokenData.paymentTelegramSentAt = new Date().toISOString();
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
    return { sent: true, configured: true };
  } catch (error) {
    console.error("Telegram payment notification error:", error);
    return { sent: false, configured: true };
  }
}

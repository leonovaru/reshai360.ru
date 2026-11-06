const TEST_FILES = {
  "7": "test_7_basic.html", "7_basic": "test_7_basic.html", "7_advanced": "test_7_advanced.html",
  "8": "test_8_basic.html", "8_basic": "test_8_basic.html", "8_advanced": "test_8_advanced.html",
  "9": "test_9_basic.html", "9_basic": "test_9_basic.html", "9_advanced": "test_9_advanced.html",
  "10": "test_10_basic.html", "10_basic": "test_10_basic.html", "10_advanced": "test_10_advanced.html",
  "11": "test_11_basic.html", "11_basic": "test_11_basic.html", "11_advanced": "test_11_advanced.html"
};

const STATE_TTL = 3600;

async function telegram(env, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_SUPPORT_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error("Telegram API request failed: " + method);
  return data.result;
}

async function sendText(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra
  });
}

async function hashEmail(email) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function getState(kv, chatId) {
  const raw = await kv.get("support-state:" + chatId);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function setState(kv, chatId, state) {
  await kv.put("support-state:" + chatId, JSON.stringify(state), { expirationTtl: STATE_TTL });
}

async function askForEmail(env, kv, chatId) {
  await setState(kv, chatId, { step: "email" });
  await sendText(env, chatId, "Здравствуйте! Это поддержка Решай360. Напишите email, который вы указывали перед оплатой диагностики.");
}

async function showMenu(env, chatId) {
  await sendText(env, chatId, "Чем можем помочь?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Не открывается диагностика", callback_data: "support:open_test" }],
        [{ text: "Не пришёл PDF-отчёт", callback_data: "support:report" }],
        [{ text: "Какой у меня промокод", callback_data: "support:promo" }],
        [{ text: "Позвать человека", callback_data: "support:human" }]
      ]
    }
  });
}

async function notifyHuman(env, chatId, state, message, telegramUserId) {
  const ticketId = crypto.randomUUID();
  const ticket = {
    id: ticketId,
    createdAt: new Date().toISOString(),
    email: state.email || null,
    telegramUserId: String(telegramUserId || ""),
    chatId: String(chatId),
    message: String(message || "").slice(0, 4000)
  };
  await env.TEST_TOKENS.put("support-ticket:" + ticketId, JSON.stringify(ticket), { expirationTtl: 31536000 });
  if (env.TELEGRAM_SUPPORT_ADMIN_CHAT_ID) {
    const adminText = [
      "🆘 НОВОЕ ОБРАЩЕНИЕ В ПОДДЕРЖКУ РЕШАЙ360",
      "Email: " + (ticket.email || "не указан"),
      "Telegram ID: " + ticket.telegramUserId,
      "Обращение: " + ticket.message,
      "ID: " + ticketId
    ].join("\n");
    await sendText(env, env.TELEGRAM_SUPPORT_ADMIN_CHAT_ID, adminText);
  }
  await setState(env.TEST_TOKENS, chatId, { step: "menu", email: state.email || null });
  await sendText(env, chatId, "Я уже позвал специалиста поддержки. Ваше обращение передано, пожалуйста, ожидайте ответа.");
}

async function getPromoRecords(env, email) {
  const hash = await hashEmail(email);
  const rawIndex = await env.TEST_TOKENS.get("promo-email:" + hash);
  let index = [];
  try { index = rawIndex ? JSON.parse(rawIndex) : []; } catch {}
  if (!Array.isArray(index)) index = [];
  const records = [];
  for (const item of index) {
    const code = String(item && item.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{5,24}$/.test(code)) continue;
    const raw = await env.TEST_TOKENS.get("promo:" + code);
    if (!raw) continue;
    try {
      const promo = JSON.parse(raw);
      if (promo.email && String(promo.email).trim().toLowerCase() !== email) continue;
      records.push({ ...promo, code });
    } catch {}
  }
  records.sort((a, b) => Number(b.issuedAt || b.createdAt || 0) - Number(a.issuedAt || a.createdAt || 0));
  return records;
}

function promoStatus(promo) {
  if (promo.used) return "использован";
  if (promo.expiresAt && Number(promo.expiresAt) <= Date.now()) return "истёк";
  if (promo.reservedUntil && Number(promo.reservedUntil) > Date.now()) return "оформляется";
  return "активен";
}

async function sendPromoInfo(env, chatId, email, name = "") {
  const promos = await getPromoRecords(env, email);
  if (!promos.length) {
    await sendText(env, chatId, "По этому email промокодов пока не найдено. Если вы считаете, что это ошибка, нажмите «Позвать человека».");
    return;
  }
  const lines = ["Ваши промокоды Решай360:"];
  for (const promo of promos) {
    const discount = Number(promo.discountPercent || 0);
    const expires = promo.expiresAt
      ? new Date(Number(promo.expiresAt)).toLocaleDateString("ru-RU")
      : "срок не указан";
    lines.push("• " + promo.code + " — скидка " + (discount || "—") + "%, до " + expires + " (" + promoStatus(promo) + ")");
  }
  await sendText(env, chatId, lines.join("\n"));

  const latest = promos[0];
  if (Number(latest.discountPercent || 10) >= 15) return;
  const prefillToken = crypto.randomUUID().replace(/-/g, "");
  await env.TEST_TOKENS.put("feedback-prefill:" + prefillToken, JSON.stringify({
    name: String(name || "").trim(),
    email,
    createdAt: Date.now()
  }), { expirationTtl: 3888000 });
  const feedbackUrl = "https://reshai360.ru/index.html?feedback_token=" + encodeURIComponent(prefillToken) + "#feedback";
  await sendText(env, chatId, "Оставьте отзыв, пожелание или идею — скидка по последнему промокоду может увеличиться до 15%: " + feedbackUrl);
}

async function findOpenDiagnostic(env, email) {
  let cursor;
  const matches = [];
  do {
    const page = await env.TEST_TOKENS.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      const key = item.name;
      if (!key || key.includes(":")) continue;
      const raw = await env.TEST_TOKENS.get(key);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw);
        if (String(record.email || "").trim().toLowerCase() !== email) continue;
        if (record.isPaid !== true || record.isCompleted === true) continue;
        if (!TEST_FILES[record.productKey]) continue;
        matches.push({ token: key, ...record });
      } catch {}
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  matches.sort((a, b) => new Date(b.paidAt || 0).getTime() - new Date(a.paidAt || 0).getTime());
  return matches[0] || null;
}

async function sendReport(env, chatId, email) {
  const hash = await hashEmail(email);
  const rawIndex = await env.TEST_TOKENS.get("report-email:" + hash);
  let index = [];
  try { index = rawIndex ? JSON.parse(rawIndex) : []; } catch {}
  if (!Array.isArray(index) || !index.length) return { found: false };
  index.sort((a, b) => new Date(b.completedAt || 0).getTime() - new Date(a.completedAt || 0).getTime());
  const report = index[0];
  if (!report.objectKey || !env.REPORTS_BUCKET) return { found: false, storageUnavailable: true };
  const object = await env.REPORTS_BUCKET.get(report.objectKey);
  if (!object) return { found: false };
  const blob = await object.blob();
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", "Ваш PDF-отчёт по диагностике Решай360.");
  form.append("document", blob, "Отчёт_Решай360.pdf");
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_SUPPORT_BOT_TOKEN + "/sendDocument", {
    method: "POST",
    body: form
  });
  if (!response.ok) throw new Error("Не удалось отправить PDF в Telegram.");
  return { found: true, name: report.studentName || "" };
}

export async function onRequestPost({ request, env }) {
  if (!env.TELEGRAM_SUPPORT_BOT_TOKEN || !env.TEST_TOKENS) {
    return new Response("Support bot is not configured", { status: 503 });
  }
  if (!env.TELEGRAM_SUPPORT_WEBHOOK_SECRET ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_SUPPORT_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const update = await request.json();
    if (update.update_id !== undefined) {
      const updateKey = "support-update:" + update.update_id;
      if (await env.TEST_TOKENS.get(updateKey)) return Response.json({ ok: true });
      await env.TEST_TOKENS.put(updateKey, "1", { expirationTtl: 86400 });
    }

    const message = update.message;
    const callback = update.callback_query;
    const chatId = message?.chat?.id ?? callback?.message?.chat?.id;
    const telegramUserId = message?.from?.id ?? callback?.from?.id;
    if (!chatId) return Response.json({ ok: true });

    if (callback) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
      const action = String(callback.data || "").replace("support:", "");
      const state = await getState(env.TEST_TOKENS, chatId);
      if (!state.email) {
        await askForEmail(env, env.TEST_TOKENS, chatId);
        return Response.json({ ok: true });
      }

      if (action === "human") {
        await setState(env.TEST_TOKENS, chatId, { ...state, step: "human" });
        await sendText(env, chatId, "Опишите, пожалуйста, ваш вопрос одним сообщением.");
      } else if (action === "open_test") {
        const order = await findOpenDiagnostic(env, state.email);
        if (!order) {
          await notifyHuman(env, chatId, state, "Не удалось автоматически найти активную ссылку на диагностику.", telegramUserId);
        } else {
          const url = "https://reshai360.ru/" + TEST_FILES[order.productKey] + "?token=" + encodeURIComponent(order.token);
          let remaining = "";
          if (order.paidAt) {
            const ms = Math.max(0, 86400000 - (Date.now() - new Date(order.paidAt).getTime()));
            if (Number.isFinite(ms)) remaining = "\nОриентировочно осталось: " + Math.floor(ms / 3600000) + " ч. " + Math.floor((ms % 3600000) / 60000) + " мин.";
          }
          await sendText(env, chatId, "Нашёл вашу диагностику. Вот персональная ссылка:\n" + url + remaining);
          await setState(env.TEST_TOKENS, chatId, { ...state, step: "thanks" });
        }
      } else if (action === "report") {
        const result = await sendReport(env, chatId, state.email);
        if (!result.found) {
          await notifyHuman(env, chatId, state, result.storageUnavailable
            ? "PDF найден в истории, но R2-хранилище пока не настроено или файл недоступен."
            : "Не найден сохранённый PDF-отчёт.", telegramUserId);
        } else {
          await sendPromoInfo(env, chatId, state.email, result.name);
          await setState(env.TEST_TOKENS, chatId, { ...state, step: "menu" });
        }
      } else if (action === "promo") {
        await sendPromoInfo(env, chatId, state.email);
        await setState(env.TEST_TOKENS, chatId, { ...state, step: "menu" });
      }
      return Response.json({ ok: true });
    }

    const text = String(message?.text || "").trim();
    if (!text) return Response.json({ ok: true });
    if (text === "/start" || text === "/restart") {
      await askForEmail(env, env.TEST_TOKENS, chatId);
      return Response.json({ ok: true });
    }

    const state = await getState(env.TEST_TOKENS, chatId);
    if (state.step === "email") {
      const email = text.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await sendText(env, chatId, "Похоже, это не email. Проверьте адрес и отправьте его ещё раз.");
      } else {
        await setState(env.TEST_TOKENS, chatId, { step: "menu", email });
        await showMenu(env, chatId);
      }
    } else if (state.step === "human") {
      await notifyHuman(env, chatId, state, text, telegramUserId);
    } else if (state.step === "thanks") {
      if (/^(спасибо|благодарю|ок|понятно|thanks|спс)[!.\s😊🙏🙂👍❤️]*$/i.test(text)) {
        await sendText(env, chatId, "Пожалуйста! Желаем продуктивного прохождения диагностики! 😊");
        await setState(env.TEST_TOKENS, chatId, { step: "menu", email: state.email });
      } else {
        await notifyHuman(env, chatId, state, text, telegramUserId);
      }
    } else if (state.email) {
      await showMenu(env, chatId);
    } else {
      await askForEmail(env, env.TEST_TOKENS, chatId);
    }
  } catch (error) {
    console.error("Support bot error:", error);
  }
  return Response.json({ ok: true });
}

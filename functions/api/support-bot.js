const TEST_FILES = {
  "7": "test_7_basic.html", "7_basic": "test_7_basic.html", "7_advanced": "test_7_advanced.html",
  "8": "test_8_basic.html", "8_basic": "test_8_basic.html", "8_advanced": "test_8_advanced.html",
  "9": "test_9_basic.html", "9_basic": "test_9_basic.html", "9_advanced": "test_9_advanced.html",
  "10": "test_10_basic.html", "10_basic": "test_10_basic.html", "10_advanced": "test_10_advanced.html",
  "11": "test_11_basic.html", "11_basic": "test_11_basic.html", "11_advanced": "test_11_advanced.html"
};
const STATE_TTL = 86400;
const TICKET_TTL = 31536000;
const QUEUE_KEY = "support-admin-queue";
const ACTIVE_KEY = "support-admin-active";

async function telegram(env, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_SUPPORT_BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error("Telegram API request failed: " + method);
  return data.result;
}
async function sendText(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
}
async function hashEmail(email) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
async function getState(kv, chatId) {
  let state = {};
  try { state = JSON.parse(await kv.get("support-state:" + chatId) || "{}"); } catch {}
  const email = await kv.get("support-email:" + chatId);
  if (email) state.email = email;
  return state;
}
async function setState(kv, chatId, state) {
  if (state.email) await kv.put("support-email:" + chatId, String(state.email).trim().toLowerCase(), { expirationTtl: TICKET_TTL });
  await kv.put("support-state:" + chatId, JSON.stringify(state), { expirationTtl: STATE_TTL });
}
async function getTicket(kv, id) {
  if (!id) return null;
  try { return JSON.parse(await kv.get("support-ticket:" + id) || "null"); } catch { return null; }
}
async function saveTicket(kv, ticket) {
  ticket.updatedAt = new Date().toISOString();
  await kv.put("support-ticket:" + ticket.id, JSON.stringify(ticket), { expirationTtl: TICKET_TTL });
}
function addHistory(ticket, from, text, extra = {}) {
  ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
  ticket.history.push({ at: new Date().toISOString(), from, text: String(text || "").slice(0, 3000), ...extra });
  ticket.history = ticket.history.slice(-100);
}
async function clientText(env, chatId, text, state, extra = {}) {
  await sendText(env, chatId, text, extra);
  if (state?.ticketId) {
    const ticket = await getTicket(env.TEST_TOKENS, state.ticketId);
    if (ticket && ticket.status !== "closed") {
      addHistory(ticket, "bot", text);
      await saveTicket(env.TEST_TOKENS, ticket);
      await refreshActiveTicket(env, ticket);
    }
  } else {
    const current = await getState(env.TEST_TOKENS, chatId);
    current.history = Array.isArray(current.history) ? current.history : [];
    current.history.push({ at: new Date().toISOString(), from: "bot", text: String(text).slice(0, 3000) });
    current.history = current.history.slice(-80);
    await setState(env.TEST_TOKENS, chatId, current);
  }
}
async function addStateBotMessage(env, chatId, text) {
  const state = await getState(env.TEST_TOKENS, chatId);
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({ at: new Date().toISOString(), from: "bot", text });
  state.history = state.history.slice(-80);
  await setState(env.TEST_TOKENS, chatId, state);
}
const CLIENT_KEYBOARD = {
  keyboard: [
    [{ text: "Не открывается диагностика" }, { text: "Не пришёл PDF-отчёт" }],
    [{ text: "Какой у меня промокод" }, { text: "Позвать специалиста" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};
async function askForEmail(env, chatId) {
  const prompt = "Здравствуйте! Это поддержка Решай360. Напишите email, который вы указывали перед оплатой диагностики.";
  const state = await getState(env.TEST_TOKENS, chatId);
  await setState(env.TEST_TOKENS, chatId, { ...state, step: "email", history: [{ at: new Date().toISOString(), from: "bot", text: prompt }] });
  await sendText(env, chatId, prompt, { reply_markup: { remove_keyboard: true } });
}
async function showMenu(env, chatId, notice = "Выберите нужный пункт поддержки:") {
  const state = await getState(env.TEST_TOKENS, chatId);
  await setState(env.TEST_TOKENS, chatId, { ...state, step: "menu", ticketId: undefined });
  await addStateBotMessage(env, chatId, notice);
  await sendText(env, chatId, notice, { reply_markup: { ...CLIENT_KEYBOARD } });
}
async function hideClientKeyboard(env, chatId) {
  await telegram(env, "sendMessage", { chat_id: chatId, text: "Принято. Выполняю запрос…", reply_markup: { remove_keyboard: true } });
}
async function getQueue(kv) {
  try { const q = JSON.parse(await kv.get(QUEUE_KEY) || "[]"); return Array.isArray(q) ? q : []; } catch { return []; }
}
async function setQueue(kv, queue) {
  await kv.put(QUEUE_KEY, JSON.stringify(queue), { expirationTtl: TICKET_TTL });
}
function ticketKeyboard(ticketId) {
  return { inline_keyboard: [
    [{ text: "💬 Ответить клиенту", callback_data: "admin:reply:" + ticketId }],
    [{ text: "📎 Отправить PDF", callback_data: "admin:pdf:" + ticketId }],
    [{ text: "🔄 Обновить переписку", callback_data: "admin:history:" + ticketId }],
    [{ text: "✅ Завершить обращение", callback_data: "admin:close:" + ticketId }]
  ] };
}
function formatHistory(ticket) {
  const lines = [
    "🆘 ОБРАЩЕНИЕ В ПОДДЕРЖКУ РЕШАЙ360",
    "ID: " + ticket.id,
    "Email: " + (ticket.email || "не указан"),
    "Клиент Telegram ID: " + ticket.telegramUserId,
    "Причина: " + (ticket.reason || "вопрос клиента"),
    "Статус: " + (ticket.status === "active" ? "в работе" : "в очереди"),
    "",
    "ИСТОРИЯ ПЕРЕПИСКИ:"
  ];
  for (const item of (ticket.history || []).slice(-25)) {
    const who = item.from === "client" ? "Клиент" : item.from === "admin" ? "Марина" : "Бот";
    lines.push("[" + new Date(item.at).toLocaleString("ru-RU") + "] " + who + ": " + (item.text || (item.document ? "Отправлен PDF" : "")));
  }
  return lines.join("\n").slice(0, 3900);
}
async function refreshActiveTicket(env, ticket) {
  if (!env.TG_CHAT_ID) return;
  const activeId = await env.TEST_TOKENS.get(ACTIVE_KEY);
  if (activeId !== ticket.id || ticket.status !== "active") return;
  const text = formatHistory(ticket);
  if (ticket.adminMessageId) {
    try {
      await telegram(env, "editMessageText", {
        chat_id: env.TG_CHAT_ID,
        message_id: ticket.adminMessageId,
        text,
        reply_markup: ticketKeyboard(ticket.id),
        disable_web_page_preview: true
      });
      return;
    } catch {}
  }
  try {
    const sent = await sendText(env, env.TG_CHAT_ID, text, { reply_markup: ticketKeyboard(ticket.id) });
    ticket.adminMessageId = sent.message_id;
    await saveTicket(env.TEST_TOKENS, ticket);
  } catch (error) {
    console.error("Support bot: failed to notify admin about active ticket:", error);
  }
}
async function activateNext(env) {
  const kv = env.TEST_TOKENS;
  let queue = await getQueue(kv);
  while (queue.length) {
    const id = queue.shift();
    const ticket = await getTicket(kv, id);
    if (!ticket || ticket.status === "closed") continue;
    ticket.status = "active";
    await saveTicket(kv, ticket);
    await setQueue(kv, queue);
    await kv.put(ACTIVE_KEY, id, { expirationTtl: TICKET_TTL });
    await refreshActiveTicket(env, ticket);
    return;
  }
  await setQueue(kv, []);
  await kv.delete(ACTIVE_KEY);
}
async function notifyQueuedTicket(env, ticket, position) {
  if (!env.TG_CHAT_ID) {
    console.error("Support bot: TG_CHAT_ID is not configured; queued ticket notification was not sent.");
    return;
  }
  const text = formatHistory(ticket) + "\n\n📥 Новое обращение добавлено в очередь.\nПозиция в очереди: " + position;
  try {
    await sendText(env, env.TG_CHAT_ID, text);
  } catch (error) {
    console.error("Support bot: failed to notify admin about queued ticket:", error);
  }
}
async function createTicket(env, chatId, state, userId, reason, firstMessage) {
  const kv = env.TEST_TOKENS;
  const ticket = {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    email: state.email || null, telegramUserId: String(userId || ""), chatId: String(chatId),
    reason, status: "queued", history: Array.isArray(state.history) ? state.history.slice(-80) : [],
    adminMessageId: null
  };
  if (firstMessage) addHistory(ticket, "client", firstMessage);
  await saveTicket(kv, ticket);
  const queue = await getQueue(kv);
  queue.push(ticket.id);
  await setQueue(kv, queue);
  await setState(kv, chatId, { step: "ticket_open", email: ticket.email, ticketId: ticket.id, history: ticket.history });
  const activeId = await kv.get(ACTIVE_KEY);
  if (!activeId) await activateNext(env);
  const nowActive = await kv.get(ACTIVE_KEY);
  const confirmation = nowActive === ticket.id
    ? "Ваше обращение принято. Я передал его специалисту поддержки. Мы ответим здесь."
    : "Ваше обращение принято и добавлено в очередь поддержки. Как только специалист завершит предыдущее обращение, мы передадим ему ваше.";
  addHistory(ticket, "bot", confirmation);
  await saveTicket(kv, ticket);
  if (nowActive === ticket.id) {
    await refreshActiveTicket(env, ticket);
  } else {
    const updatedQueue = await getQueue(kv);
    const position = updatedQueue.indexOf(ticket.id) + 1;
    await notifyQueuedTicket(env, ticket, position || updatedQueue.length);
  }
  await sendText(env, chatId, confirmation, { reply_markup: { remove_keyboard: true } });
  if (reason === "Повторная отправка PDF-отчёта") await sendWaitingReportPromo(env, chatId, ticket.email, ticket);
  return ticket;
}
async function closeTicket(env, ticket) {
  ticket.status = "closed";
  ticket.closedAt = new Date().toISOString();
  await saveTicket(env.TEST_TOKENS, ticket);
  const queue = (await getQueue(env.TEST_TOKENS)).filter(id => id !== ticket.id);
  await setQueue(env.TEST_TOKENS, queue);
  await env.TEST_TOKENS.delete(ACTIVE_KEY);
  const state = await getState(env.TEST_TOKENS, ticket.chatId);
  await setState(env.TEST_TOKENS, ticket.chatId, { step: "menu", email: ticket.email, history: state.history || [] });
  await sendText(env, ticket.chatId, "Спасибо за обращение! Ваш запрос обработан.", { reply_markup: { ...CLIENT_KEYBOARD } });
  await setState(env.TEST_TOKENS, ticket.chatId, { step: "menu", email: ticket.email, history: state.history || [] });
  await activateNext(env);
}
async function getPromoRecords(env, email) {
  const hash = await hashEmail(email);
  const rawIndex = await env.TEST_TOKENS.get("promo-email:" + hash);
  let index = [];
  try { index = rawIndex ? JSON.parse(rawIndex) : []; } catch {}
  if (!Array.isArray(index)) index = [];
  const records = [];
  for (const item of index) {
    const code = String(item?.code || "").trim().toUpperCase();
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
async function sendWaitingReportPromo(env, chatId, email, ticket) {
  const promos = await getPromoRecords(env, email);
  const latest = promos.find(promo => promoStatus(promo) === "активен");
  if (!latest) return;
  const feedbackToken = crypto.randomUUID().replace(/-/g, "");
  await env.TEST_TOKENS.put("feedback-prefill:" + feedbackToken, JSON.stringify({
    name: String(latest.name || "").trim(), email, createdAt: Date.now()
  }), { expirationTtl: 3888000 });
  const feedbackUrl = "https://reshai360.ru/index.html?feedback_token=" + encodeURIComponent(feedbackToken) + "#feedback";
  const discount = Number(latest.discountPercent || 10);
  const message = "Мы ищем ваш отчёт, это может занять некоторое время\n\n🎁 Подарок за прохождение\n\n" +
    latest.code + "\n\nПромокод даёт скидку " + discount +
    "% на следующую диагностику. Используйте его сами или поделитесь с другом. Код одноразовый и действует 45 дней." +
    (discount < 15 ? "\n\nОставьте отзыв, пожелание или идею — скидка по последнему активному промокоду увеличится до 15%. <a href=\"" + feedbackUrl + "\">Открыть форму обратной связи</a>." : "");
  addHistory(ticket, "bot", message.replace(/<[^>]+>/g, ""));
  await saveTicket(env.TEST_TOKENS, ticket);
  await sendText(env, chatId, message, { parse_mode: "HTML" });
}
async function sendPromoInfo(env, chatId, email, state) {
  const promos = await getPromoRecords(env, email);
  if (!promos.length) {
    await clientText(env, chatId, "По этому email промокодов пока не найдено. Если вы считаете, что это ошибка, выберите «Позвать человека».", state);
    return;
  }
  const lines = ["Ваши промокоды Решай360:"];
  for (const promo of promos) {
    const expires = promo.expiresAt ? new Date(Number(promo.expiresAt)).toLocaleDateString("ru-RU") : "срок не указан";
    lines.push("• " + promo.code + " — скидка " + Number(promo.discountPercent || 0) + "%, до " + expires + " (" + promoStatus(promo) + ")");
  }
  await clientText(env, chatId, lines.join("\n"), state);
  const latest = promos.find(promo => promoStatus(promo) === "активен");
  if (!latest || Number(latest.discountPercent || 10) >= 15) return;
  const latestOrder = await findOrder(env, email, true) || await findOrder(env, email, false);
  const prefillName = String(latest.name || latestOrder?.name || latestOrder?.customerName || state?.name || "").trim();
  const prefillToken = crypto.randomUUID().replace(/-/g, "");
  await env.TEST_TOKENS.put("feedback-prefill:" + prefillToken, JSON.stringify({
    name: prefillName, email, createdAt: Date.now()
  }), { expirationTtl: 3888000 });
  const feedbackUrl = "https://reshai360.ru/index.html?feedback_token=" + encodeURIComponent(prefillToken) + "#feedback";
  const feedbackText = "Оставьте отзыв, пожелание или идею — скидка по последнему активному промокоду может увеличиться до 15%: <a href=\"" + feedbackUrl + "\">перейти к форме обратной связи</a>.";
  await clientText(env, chatId, feedbackText, state, { parse_mode: "HTML" });
}
async function findOrder(env, email, completed) {
  let cursor;
  const matches = [];
  do {
    const page = await env.TEST_TOKENS.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      if (!item.name || item.name.includes(":")) continue;
      const raw = await env.TEST_TOKENS.get(item.name);
      if (!raw) continue;
      try {
        const r = JSON.parse(raw);
        if (String(r.email || "").trim().toLowerCase() !== email || r.isPaid !== true) continue;
        if (!TEST_FILES[r.productKey]) continue;
        if (completed ? r.isCompleted !== true : r.isCompleted === true) continue;
        matches.push({ token: item.name, ...r });
      } catch {}
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  matches.sort((a, b) => new Date(b.completedAt || b.paidAt || 0) - new Date(a.completedAt || a.paidAt || 0));
  return matches[0] || null;
}
async function adminAction(env, callback, chatId) {
  if (String(chatId) !== String(env.TG_CHAT_ID || "")) return false;
  const parts = String(callback.data || "").split(":");
  if (parts.length !== 3) return true;
  const action = parts[1], id = parts[2];
  const ticket = await getTicket(env.TEST_TOKENS, id);
  if (!ticket || ticket.status === "closed") {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Обращение уже закрыто или не найдено." });
    return true;
  }
  if (await env.TEST_TOKENS.get(ACTIVE_KEY) !== id) {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Это обращение ещё ожидает своей очереди." });
    return true;
  }
  await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
  if (action === "reply") {
    await env.TEST_TOKENS.put("support-admin-state:" + chatId, JSON.stringify({ mode: "reply", ticketId: id }), { expirationTtl: 3600 });
    await sendText(env, chatId, "Напишите ответ клиенту одним сообщением. Я отправлю его от имени поддержки Решай360.");
  } else if (action === "pdf") {
    await env.TEST_TOKENS.put("support-admin-state:" + chatId, JSON.stringify({ mode: "pdf", ticketId: id }), { expirationTtl: 3600 });
    await sendText(env, chatId, "Теперь отправьте или перешлите сюда PDF-файл. Я передам его клиенту из этого обращения.");
  } else if (action === "history") {
    const sent = await sendText(env, chatId, formatHistory(ticket), { reply_markup: ticketKeyboard(id) });
    ticket.adminMessageId = sent.message_id;
    await saveTicket(env.TEST_TOKENS, ticket);
  } else if (action === "close") {
    await closeTicket(env, ticket);
  }
  return true;
}
async function handleAdminMessage(env, message, chatId) {
  const raw = await env.TEST_TOKENS.get("support-admin-state:" + chatId);
  if (!raw) return false;
  let adminState;
  try { adminState = JSON.parse(raw); } catch { return false; }
  const ticket = await getTicket(env.TEST_TOKENS, adminState.ticketId);
  const isCurrentActive = ticket && ticket.status === "active" && await env.TEST_TOKENS.get(ACTIVE_KEY) === ticket.id;
  const canSendPdfToOpenTicket = ticket && ticket.status !== "closed" && adminState.mode === "pdf";
  if (!ticket || ticket.status === "closed" || (!isCurrentActive && !canSendPdfToOpenTicket)) {
    await env.TEST_TOKENS.delete("support-admin-state:" + chatId);
    await sendText(env, chatId, "Это обращение уже закрыто или недоступно. Выберите действие в актуальном уведомлении.");
    return true;
  }
  if (adminState.mode === "reply") {
    const answer = String(message.text || "").trim();
    if (!answer) { await sendText(env, chatId, "Напишите текстовый ответ клиенту."); return true; }
    await sendText(env, ticket.chatId, answer);
    addHistory(ticket, "admin", answer);
    await saveTicket(env.TEST_TOKENS, ticket);
    await env.TEST_TOKENS.delete("support-admin-state:" + chatId);
    await refreshActiveTicket(env, ticket);
    await sendText(env, chatId, "Ответ отправлен клиенту. Обращение остаётся открытым до нажатия «Завершить обращение».");
    return true;
  }
  if (adminState.mode === "pdf") {
    const doc = message.document;
    if (!doc || (doc.mime_type && doc.mime_type !== "application/pdf" && !String(doc.file_name || "").toLowerCase().endsWith(".pdf"))) {
      await sendText(env, chatId, "Пожалуйста, отправьте PDF именно как документ.");
      return true;
    }
    await telegram(env, "sendDocument", {
      chat_id: ticket.chatId, document: doc.file_id,
      caption: "Ваш PDF-отчёт по диагностике Решай360."
    });
    addHistory(ticket, "admin", "Отправлен PDF-отчёт клиенту", { document: true, fileName: doc.file_name || "" });
    await saveTicket(env.TEST_TOKENS, ticket);
    await env.TEST_TOKENS.delete("support-admin-state:" + chatId);
    await refreshActiveTicket(env, ticket);
    await sendText(env, chatId, "PDF отправлен клиенту. Обращение будет завершено автоматически.");
    await closeTicket(env, ticket);
    return true;
  }
  return false;
}
export async function onRequestPost({ request, env }) {
  if (!env.TELEGRAM_SUPPORT_BOT_TOKEN || !env.TEST_TOKENS) return new Response("Support bot is not configured", { status: 503 });
  if (!env.TELEGRAM_SUPPORT_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_SUPPORT_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const update = await request.json();
    const message = update.message;
    const callback = update.callback_query;
    const chatId = message?.chat?.id ?? callback?.message?.chat?.id;
    if (!chatId) return Response.json({ ok: true });
    const isAdmin = String(chatId) === String(env.TG_CHAT_ID || "");
    if (callback && isAdmin) {
      await adminAction(env, callback, chatId);
      return Response.json({ ok: true });
    }
    if (message && isAdmin) {
      const handled = await handleAdminMessage(env, message, chatId);
      if (handled) return Response.json({ ok: true });
      if (message.text === "/start" || message.text === "/restart") {
        const activeId = await env.TEST_TOKENS.get(ACTIVE_KEY);
        const activeTicket = activeId ? await getTicket(env.TEST_TOKENS, activeId) : null;
        if (activeTicket && activeTicket.status === "active") {
          await refreshActiveTicket(env, activeTicket);
        } else {
          const q = await getQueue(env.TEST_TOKENS);
          await sendText(env, chatId, "Сейчас нет активного обращения.\nВ очереди: " + q.length);
        }
      } else if (message.text === "/queue") {
        const q = await getQueue(env.TEST_TOKENS);
        const active = await env.TEST_TOKENS.get(ACTIVE_KEY);
        await sendText(env, chatId, "Активное обращение: " + (active || "нет") + "\nВ очереди: " + q.length);
      } else {
        await sendText(env, chatId, "Откройте актуальное обращение и выберите действие под сообщением: «Ответить», «Отправить PDF» или «Завершить».");
      }
      return Response.json({ ok: true });
    }
    if (update.update_id !== undefined) {
      const updateKey = "support-update:" + update.update_id;
      if (await env.TEST_TOKENS.get(updateKey)) return Response.json({ ok: true });
      await env.TEST_TOKENS.put(updateKey, "1", { expirationTtl: 86400 });
    }
    if (callback) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
      return Response.json({ ok: true });
    }
    if (!message) return Response.json({ ok: true });
    const state = await getState(env.TEST_TOKENS, chatId);
    const text = String(message.text || "").trim();
    if (text === "/start" || text === "/restart" || text === "/menu" || text === "☰ Меню") {
      if (state.email) await showMenu(env, chatId);
      else await askForEmail(env, chatId);
      return Response.json({ ok: true });
    }
    if (state.step === "after_promo") {
      if (/^(да|yes)$/i.test(text)) {
        await showMenu(env, chatId);
      } else if (/^(нет|no)$/i.test(text)) {
        const reply = "Спасибо за обращение в Решай360! Если понадобится помощь, меню всегда доступно в чате. 😊";
        await clientText(env, chatId, reply, state);
        await setState(env.TEST_TOKENS, chatId, { ...state, step: "menu" });
      } else {
        await showMenu(env, chatId);
      }
      return Response.json({ ok: true });
    }
    if (state.step === "menu" && state.email) {
      const actions = {
        "Не открывается диагностика": "open_test",
        "Не пришёл PDF-отчёт": "report",
        "Какой у меня промокод": "promo",
        "Позвать специалиста": "human"
      };
      const action = actions[text];
      if (action) {
        await hideClientKeyboard(env, chatId);
        state.history = [...(state.history || []), { at: new Date().toISOString(), from: "client", text: "Выбрано действие: " + text }];
        await setState(env.TEST_TOKENS, chatId, { ...state, step: action === "human" ? "human" : "processing" });
        if (action === "human") {
          const prompt = "Опишите, пожалуйста, ваш вопрос одним сообщением.";
          await addStateBotMessage(env, chatId, prompt);
          await sendText(env, chatId, prompt);
        } else if (action === "open_test") {
          const order = await findOrder(env, state.email, false);
          if (!order) {
            await createTicket(env, chatId, state, message.from?.id, "Не открывается диагностика", "Не удалось автоматически найти активную ссылку на диагностику.");
          } else {
            const url = "https://reshai360.ru/" + TEST_FILES[order.productKey] + "?token=" + encodeURIComponent(order.token);
            let remaining = "";
            if (order.paidAt) {
              const expiresAt = new Date(new Date(order.paidAt).getTime() + 7 * 86400000);
              const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000));
              remaining = "\nСсылка действительна ещё " + daysLeft + " дн.";
            }
            const reply = "Нашёл вашу диагностику. Вот персональная ссылка:\n" + url + remaining;
            state.history = [...(state.history || []), { at: new Date().toISOString(), from: "bot", text: reply }];
            await setState(env.TEST_TOKENS, chatId, { ...state, step: "menu" });
            await sendText(env, chatId, reply, { reply_markup: { ...CLIENT_KEYBOARD } });
          }
        } else if (action === "report") {
          const completed = await findOrder(env, state.email, true);
          if (completed) {
            await createTicket(env, chatId, state, message.from?.id, "Повторная отправка PDF-отчёта", "Клиент запросил повторную отправку PDF. Требуется найти отчёт в боте «Результаты» и переслать его в бот поддержки.");
          } else {
            const unfinished = await findOrder(env, state.email, false);
            if (unfinished) {
              const reply = "Чтобы сформировать отчёт, завершите диагностику, нажав на зелёную кнопку внизу страницы. После этого вы сможете скачать отчёт прямо на странице с результатами или посмотреть его в письме на почте.";
              await setState(env.TEST_TOKENS, chatId, { ...state, step: "menu" });
              await sendText(env, chatId, reply, { reply_markup: { ...CLIENT_KEYBOARD } });
            } else {
              await createTicket(env, chatId, state, message.from?.id, "Не пришёл PDF-отчёт", "Не удалось автоматически определить статус отчёта. Нужно проверить заказ вручную.");
            }
          }
        } else if (action === "promo") {
          await sendPromoInfo(env, chatId, state.email, state);
          const updatedState = await getState(env.TEST_TOKENS, chatId);
          await setState(env.TEST_TOKENS, chatId, { ...updatedState, step: "menu" });
          await sendText(env, chatId, "Выберите нужный пункт поддержки:", { reply_markup: { ...CLIENT_KEYBOARD } });
        }
        return Response.json({ ok: true });
      }
    }
    if (state.ticketId) {
      const ticket = await getTicket(env.TEST_TOKENS, state.ticketId);
      if (ticket && ticket.status !== "closed") {
        addHistory(ticket, "client", text || (message.document ? "Клиент отправил документ" : "Новое сообщение"));
        addHistory(ticket, "bot", "Сообщение добавлено к вашему обращению. Специалист увидит его в переписке.");
        await saveTicket(env.TEST_TOKENS, ticket);
        await refreshActiveTicket(env, ticket);
        await sendText(env, chatId, "Сообщение добавлено к вашему обращению. Специалист увидит его в переписке.");
        return Response.json({ ok: true });
      }
    }
    if (state.step === "email") {
      const email = text.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const prompt = "Похоже, это не email. Проверьте адрес и отправьте его ещё раз.";
        state.history = [...(state.history || []), { at: new Date().toISOString(), from: "client", text }, { at: new Date().toISOString(), from: "bot", text: prompt }];
        await setState(env.TEST_TOKENS, chatId, state);
        await sendText(env, chatId, prompt);
      } else {
        await setState(env.TEST_TOKENS, chatId, { step: "menu", email, name: String(message.from?.first_name || "").trim(), history: [{ at: new Date().toISOString(), from: "client", text: "Email: " + email }] });
        await showMenu(env, chatId, "Email принят. Выберите нужный пункт поддержки.");
      }
    } else if (state.step === "human") {
      state.history = [...(state.history || []), { at: new Date().toISOString(), from: "client", text }];
      await createTicket(env, chatId, state, message.from?.id, "Вопрос клиента", text);
    } else if (state.step === "thanks") {
      if (/^(спасибо|благодарю|ок|понятно|thanks|спс)[!.\s😊🙏🙂👍❤️]*$/i.test(text)) {
        const reply = "Пожалуйста! Желаем продуктивного прохождения диагностики! 😊";
        state.history = [...(state.history || []), { at: new Date().toISOString(), from: "client", text }, { at: new Date().toISOString(), from: "bot", text: reply }];
        await sendText(env, chatId, reply);
        await setState(env.TEST_TOKENS, chatId, { step: "menu", email: state.email, history: state.history || [] });
      } else {
        state.history = [...(state.history || []), { at: new Date().toISOString(), from: "client", text }];
        await createTicket(env, chatId, state, message.from?.id, "Вопрос после получения ссылки", text);
      }
    } else if (state.email) {
      await showMenu(env, chatId);
    } else {
      await askForEmail(env, chatId);
    }
  } catch (error) {
    console.error("Support bot error:", error);
  }
  return Response.json({ ok: true });
}
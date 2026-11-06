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
  try { return JSON.parse(await kv.get("support-state:" + chatId) || "{}"); } catch { return {}; }
}
async function setState(kv, chatId, state) {
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
async function clientText(env, chatId, text, state) {
  await sendText(env, chatId, text);
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
async function askForEmail(env, chatId) {
  const prompt = "Здравствуйте! Это поддержка Решай360. Напишите email, который вы указывали перед оплатой диагностики.";
  await setState(env.TEST_TOKENS, chatId, { step: "email", history: [{ at: new Date().toISOString(), from: "bot", text: prompt }] });
  await sendText(env, chatId, prompt);
}
async function showMenu(env, chatId) {
  await addStateBotMessage(env, chatId, "Чем можем помочь?");
  await sendText(env, chatId, "Чем можем помочь?", { reply_markup: { inline_keyboard: [
    [{ text: "Не открывается диагностика", callback_data: "support:open_test" }],
    [{ text: "Не пришёл PDF-отчёт", callback_data: "support:report" }],
    [{ text: "Какой у меня промокод", callback_data: "support:promo" }],
    [{ text: "Позвать человека", callback_data: "support:human" }]
  ] } });
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
  const sent = await sendText(env, env.TG_CHAT_ID, text, { reply_markup: ticketKeyboard(ticket.id) });
  ticket.adminMessageId = sent.message_id;
  await saveTicket(env.TEST_TOKENS, ticket);
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
  await setState(kv, chatId, { step: "ticket_open", email: ticket.email, ticketId: ticket.id });
  const activeId = await kv.get(ACTIVE_KEY);
  if (!activeId) await activateNext(env);
  const nowActive = await kv.get(ACTIVE_KEY);
  const confirmation = nowActive === ticket.id
    ? "Ваше обращение принято. Я передал его специалисту поддержки. Мы ответим здесь."
    : "Ваше обращение принято и добавлено в очередь поддержки. Как только специалист завершит предыдущее обращение, мы передадим ему ваше.";
  addHistory(ticket, "bot", confirmation);
  await saveTicket(kv, ticket);
  if (nowActive === ticket.id) await refreshActiveTicket(env, ticket);
  await sendText(env, chatId, confirmation);
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
  await sendText(env, ticket.chatId, "Ваше обращение завершено. Если понадобится помощь, вы можете снова выбрать нужный пункт в меню.");
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
  const latest = promos[0];
  if (Number(latest.discountPercent || 10) >= 15) return;
  const prefillToken = crypto.randomUUID().replace(/-/g, "");
  await env.TEST_TOKENS.put("feedback-prefill:" + prefillToken, JSON.stringify({
    name: "", email, createdAt: Date.now()
  }), { expirationTtl: 3888000 });
  const feedbackUrl = "https://reshai360.ru/index.html?feedback_token=" + encodeURIComponent(prefillToken) + "#feedback";
  await clientText(env, chatId, "Оставьте отзыв, пожелание или идею — скидка по последнему промокоду может увеличиться до 15%: " + feedbackUrl, state);
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
  if (!ticket || ticket.status !== "active" || await env.TEST_TOKENS.get(ACTIVE_KEY) !== ticket.id) {
    await env.TEST_TOKENS.delete("support-admin-state:" + chatId);
    await sendText(env, chatId, "Это обращение уже не активно. Выберите действие в актуальном уведомлении.");
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
    if (!doc) { await sendText(env, chatId, "Пожалуйста, отправьте PDF именно как документ."); return true; }
    await telegram(env, "sendDocument", {
      chat_id: ticket.chatId, document: doc.file_id,
      caption: "Ваш PDF-отчёт по диагностике Решай360."
    });
    addHistory(ticket, "admin", "Отправлен PDF-отчёт клиенту", { document: true, fileName: doc.file_name || "" });
    await saveTicket(env.TEST_TOKENS, ticket);
    await env.TEST_TOKENS.delete("support-admin-state:" + chatId);
    await refreshActiveTicket(env, ticket);
    await sendText(env, chatId, "PDF отправлен клиенту. Обращение остаётся открытым — нажмите «Завершить обращение», когда закончите.");
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
      if (message.text === "/queue") {
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
      const action = String(callback.data || "").replace("support:", "");
      const state = await getState(env.TEST_TOKENS, chatId);
      state.history = [...(state.history || []), { at: new Date().toISOString(), from: "client", text: "Выбрано действие: " + action }];
      await setState(env.TEST_TOKENS, chatId, state);
      if (!state.email) { await askForEmail(env, chatId); return Response.json({ ok: true }); }
      if (action === "human") {
        await setState(env.TEST_TOKENS, chatId, { ...state, step: "human" });
        await addStateBotMessage(env, chatId, "Опишите, пожалуйста, ваш вопрос одним сообщением.");
        await sendText(env, chatId, "Опишите, пожалуйста, ваш вопрос одним сообщением.");
      } else if (action === "open_test") {
        const order = await findOrder(env, state.email, false);
        if (!order) {
          await createTicket(env, chatId, state, callback.from?.id, "Не открывается диагностика", "Не удалось автоматически найти активную ссылку на диагностику.");
        } else {
          const url = "https://reshai360.ru/" + TEST_FILES[order.productKey] + "?token=" + encodeURIComponent(order.token);
          let remaining = "";
          if (order.paidAt) {
            const ms = Math.max(0, 86400000 - (Date.now() - new Date(order.paidAt).getTime()));
            if (Number.isFinite(ms)) remaining = "\nОриентировочно осталось: " + Math.floor(ms / 3600000) + " ч. " + Math.floor((ms % 3600000) / 60000) + " мин.";
          }
          const reply = "Нашёл вашу диагностику. Вот персональная ссылка:\n" + url + remaining;
          state.history = [...(state.history || []), { at: new Date().toISOString(), from: "bot", text: reply }];
          await sendText(env, chatId, reply);
          await setState(env.TEST_TOKENS, chatId, { ...state, step: "thanks" });
        }
      } else if (action === "report") {
        const completed = await findOrder(env, state.email, true);
        if (completed) {
          await createTicket(env, chatId, state, callback.from?.id, "Повторная отправка PDF-отчёта", "Клиент запросил повторную отправку PDF. Требуется найти отчёт в боте «Результаты» и переслать его в бот поддержки.");
        } else {
          const unfinished = await findOrder(env, state.email, false);
          if (unfinished) {
            const reply = "Чтобы сформировать отчёт, завершите диагностику, нажав на зелёную кнопку внизу страницы. После этого вы сможете скачать отчёт прямо на странице с результатами или посмотреть его в письме на почте.";
            state.history = [...(state.history || []), { at: new Date().toISOString(), from: "bot", text: reply }];
            await sendText(env, chatId, reply);
            await setState(env.TEST_TOKENS, chatId, { ...state, step: "menu" });
          } else {
            await createTicket(env, chatId, state, callback.from?.id, "Не пришёл PDF-отчёт", "Не удалось автоматически определить статус отчёта. Нужно проверить заказ вручную.");
          }
        }
      } else if (action === "promo") {
        await sendPromoInfo(env, chatId, state.email, state);
        const updatedState = await getState(env.TEST_TOKENS, chatId);
        await setState(env.TEST_TOKENS, chatId, { ...updatedState, step: "menu" });
      }
      return Response.json({ ok: true });
    }
    if (!message) return Response.json({ ok: true });
    const state = await getState(env.TEST_TOKENS, chatId);
    const text = String(message.text || "").trim();
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
    if (text === "/start" || text === "/restart") {
      await askForEmail(env, chatId);
      return Response.json({ ok: true });
    }
    if (state.step === "email") {
      const email = text.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const prompt = "Похоже, это не email. Проверьте адрес и отправьте его ещё раз.";
        state.history = [...(state.history || []), { at: new Date().toISOString(), from: "client", text }, { at: new Date().toISOString(), from: "bot", text: prompt }];
        await setState(env.TEST_TOKENS, chatId, state);
        await sendText(env, chatId, prompt);
      } else {
        await setState(env.TEST_TOKENS, chatId, { step: "menu", email, history: [{ at: new Date().toISOString(), from: "client", text: "Email: " + email }] });
        await showMenu(env, chatId);
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
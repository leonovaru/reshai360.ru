import { ensurePaidOrderLinkExpiry, getOrderExpirationTtl } from "../_lib/telegram-payment.js";
import { scheduleOrderSync } from "../_lib/google-sheets.js";
import { getPaidGrade7Order, isGrade7V2Product } from "../_lib/grade7-d1-progress.js";

const RESULTS_REPORT_VERSION = 10;
const GRADE7_V2_REPORT_VERSION = 12;

async function getPromoRecordsForEmail(env, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return [];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedEmail));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  let index = [];
  try { index = JSON.parse(await env.TEST_TOKENS.get("promo-email:" + hash) || "[]"); } catch {}
  if (!Array.isArray(index)) return [];
  const records = [];
  for (const item of index) {
    const code = String(item?.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{5,24}$/.test(code)) continue;
    const raw = await env.TEST_TOKENS.get("promo:" + code);
    if (!raw) continue;
    try {
      const promo = JSON.parse(raw);
      if (promo.email && String(promo.email).trim().toLowerCase() !== normalizedEmail) continue;
      records.push({ ...promo, code });
    } catch {}
  }
  return records.sort((a, b) => Number(b.issuedAt || b.createdAt || 0) - Number(a.issuedAt || a.createdAt || 0));
}
function getPromoStatusForMessage(promo) {
  if (promo.used) return "использован";
  if (promo.expiresAt && Number(promo.expiresAt) <= Date.now()) return "истёк";
  if (promo.reservedUntil && Number(promo.reservedUntil) > Date.now()) return "оформляется";
  return "активен";
}
async function sendAutomaticSupportPromo(env, chatId, email, feedbackToken) {
  const promos = await getPromoRecordsForEmail(env, email);
  if (!promos.length) return false;
  const lines = ["🎁 Подарок за прохождение", "Ваши промокоды Решай360:"];
  for (const promo of promos) {
    const expires = promo.expiresAt
      ? new Date(Number(promo.expiresAt)).toLocaleDateString("ru-RU")
      : "срок не указан";
    lines.push("• " + promo.code + " — скидка " + Number(promo.discountPercent || 0) + "%, до " + expires + " (" + getPromoStatusForMessage(promo) + ")");
  }
  const latest = promos.find(promo => getPromoStatusForMessage(promo) === "активен");
  if (latest && Number(latest.discountPercent || 10) < 15 && feedbackToken) {
    const feedbackUrl = "https://reshai360.ru/index.html?feedback_token=" + encodeURIComponent(feedbackToken) + "#feedback";
    lines.push("", "Оставьте отзыв, пожелание или идею — скидка по последнему активному промокоду увеличится до 15%: <a href=\"" + feedbackUrl + "\">перейти к форме обратной связи</a>.");
  }
  lines.push("", "Можем ли ещё чем-нибудь помочь?");
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_SUPPORT_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        keyboard: [[{ text: "Да" }, { text: "Нет" }]],
        resize_keyboard: true,
        is_persistent: true
      }
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error("Support promo message was not accepted by Telegram");
  const stateKey = "support-state:" + chatId;
  let state = {};
  try { state = JSON.parse(await env.TEST_TOKENS.get(stateKey) || "{}"); } catch {}
  state.email = normalizedEmailForSupport(email);
  state.step = "after_promo";
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({ at: new Date().toISOString(), from: "bot", text: lines.join("\n").replace(/<[^>]+>/g, "") });
  state.history = state.history.slice(-80);
  await env.TEST_TOKENS.put(stateKey, JSON.stringify(state), { expirationTtl: 86400 });
  return true;
}
function normalizedEmailForSupport(email) {
  return String(email || "").trim().toLowerCase();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const formData = await request.formData();

    const token = String(formData.get("token") || "").trim();
    const submittedEmail = String(formData.get("email") || "").trim();
    const submittedName = String(formData.get("name") || "Ученик").trim();
    const score = formData.get("score");
    const total = formData.get("total");
    const pdfFile = formData.get("document");
    const forceEmail = String(formData.get("forceEmail") || "") === "true";
    let answersSnapshot = null;
    try {
      const rawSnapshot = formData.get("answersSnapshot");
      if (rawSnapshot) {
        const parsed = JSON.parse(String(rawSnapshot));
        if (parsed && typeof parsed === "object" && parsed.answers && typeof parsed.answers === "object") {
          answersSnapshot = {
            answers: parsed.answers,
            marked: Array.isArray(parsed.marked) ? parsed.marked : [],
            stats: parsed.stats && typeof parsed.stats === "object" ? parsed.stats : {},
            diagnosticProfile: parsed.diagnosticProfile && typeof parsed.diagnosticProfile === "object" && !Array.isArray(parsed.diagnosticProfile)
              ? parsed.diagnosticProfile
              : null
          };
        }
      }
    } catch (_) {
      return Response.json({ success: false, message: "Не удалось сохранить ответы диагностики." }, { status: 400 });
    }

    // Отчёт и бонусный промокод доступны только по действительному оплаченному заказу.
    if (!token || !env.TEST_TOKENS) {
      return Response.json(
        { success: false, message: "Не удалось подтвердить оплаченный заказ." },
        { status: 403 }
      );
    }
    const tokenDataRaw = await env.TEST_TOKENS.get(token);
    if (!tokenDataRaw) {
      return Response.json(
        { success: false, message: "Ссылка на диагностику недействительна или истекла." },
        { status: 403 }
      );
    }
    const tokenData = JSON.parse(tokenDataRaw);
    const reportVersion = isGrade7V2Product(tokenData.productKey) ? GRADE7_V2_REPORT_VERSION : RESULTS_REPORT_VERSION;
    let authoritativeGrade7Snapshot = null;
    if (isGrade7V2Product(tokenData.productKey)) {
      const access = await getPaidGrade7Order(env, token, request);
      if (access.error) return Response.json({ success: false, message: "Не удалось подтвердить завершённую диагностику." }, { status: access.status || 403 });
      const completion = await env.DB.prepare(`
        SELECT snapshot_json
        FROM diagnostic_completions
        WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
      `).bind(token, access.diagnostic.diagnosticId, access.diagnostic.diagnosticVersion).first();
      if (!completion?.snapshot_json) {
        return Response.json({ success: false, message: "Сначала завершите диагностику и зафиксируйте результат." }, { status: 409 });
      }
      try { authoritativeGrade7Snapshot = JSON.parse(completion.snapshot_json); }
      catch { return Response.json({ success: false, message: "Не удалось прочитать зафиксированный результат." }, { status: 500 }); }
      // Для v2 серверный снимок и серверная оценка имеют приоритет над полями формы.
      answersSnapshot = authoritativeGrade7Snapshot;
      tokenData.answersSnapshot = authoritativeGrade7Snapshot;
    }
    if (tokenData.isPaid !== true) {
      return Response.json(
        { success: false, message: "Отчёт доступен только после подтверждения оплаты." },
        { status: 403 }
      );
    }
    ensurePaidOrderLinkExpiry(tokenData);

    // Используем контактные данные из серверной записи заказа.
    const email = String((forceEmail && submittedEmail ? submittedEmail : (tokenData.email || submittedEmail))).trim();
    const name = String(tokenData.studentName || submittedName).trim();

    if (!pdfFile || typeof pdfFile.arrayBuffer !== "function") {
      return Response.json(
        { success: false, message: "PDF-файл не получен" },
        { status: 400 }
      );
    }

    const scoreNumber = authoritativeGrade7Snapshot
      ? Number(authoritativeGrade7Snapshot.scoring?.correct || 0)
      : Number(score);
    const totalNumber = authoritativeGrade7Snapshot
      ? Number(authoritativeGrade7Snapshot.reportMetadata?.questionCount || authoritativeGrade7Snapshot.questions?.length || 0)
      : Number(total);
    const evaluatedRaw = formData.get("evaluated");
    const evaluatedNumber = authoritativeGrade7Snapshot
      ? Number(authoritativeGrade7Snapshot.scoring?.correct || 0) + Number(authoritativeGrade7Snapshot.scoring?.incorrect || 0)
      : (evaluatedRaw == null || evaluatedRaw === "" ? totalNumber : Number(evaluatedRaw));

    if (
      !Number.isFinite(scoreNumber) ||
      !Number.isFinite(totalNumber) ||
      !Number.isFinite(evaluatedNumber) ||
      totalNumber <= 0 ||
      evaluatedNumber < 0 ||
      evaluatedNumber > totalNumber ||
      scoreNumber < 0 ||
      scoreNumber > evaluatedNumber
    ) {
      return Response.json(
        { success: false, message: "Некорректный результат теста" },
        { status: 400 }
      );
    }

    const percent = evaluatedNumber > 0 ? Math.round((scoreNumber / evaluatedNumber) * 100) : null;
    const resultSummary = evaluatedNumber > 0
      ? scoreNumber + " из " + evaluatedNumber + " оценённых ответов (" + percent + "%)"
      : "нет оценённых ответов";
    const safeName = String(name || "Ученик").replace(/[\\/:*?"<>|]/g, "_");
    const safeNameHtml = String(name || "ученик").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\x27/g, "&#39;");

    let promoCode = null;
    let emailSent = false;
    let emailError = null;
    let emailId = null;
    let feedbackPrefillToken = null;
    {
        tokenData.isCompleted = true;
        if (answersSnapshot) {
          const isGrade7V2 = tokenData.productKey === "7_basic_v2" || tokenData.productKey === "7_advanced_v2";
          // Для новой диагностики сохраняем первый завершённый снимок неизменным.
          if (!isGrade7V2 || !tokenData.answersSnapshot) tokenData.answersSnapshot = answersSnapshot;
        }
        tokenData.completedAt = tokenData.completedAt || new Date().toISOString();

        // Один промокод на завершённую диагностику; повторный запрос отчёта не создаёт новый.
        if (tokenData.promoCodeIssued) {
          promoCode = tokenData.promoCodeIssued;
        } else {
          const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
          for (let attempt = 0; attempt < 8 && !promoCode; attempt++) {
            const bytes = new Uint8Array(10);
            crypto.getRandomValues(bytes);
            const candidate = "R360-" + Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
            const exists = await env.TEST_TOKENS.get("promo:" + candidate);
            if (!exists) promoCode = candidate;
          }
          if (!promoCode) throw new Error("Не удалось сгенерировать промокод");
          await env.TEST_TOKENS.put("promo:" + promoCode, JSON.stringify({
            code: promoCode,
            discountPercent: 10,
            createdAt: Date.now(),
            expiresAt: Date.now() + 45 * 24 * 60 * 60 * 1000,
            used: false,
            reservedBy: null,
            reservedUntil: null
          }), { expirationTtl: 45 * 24 * 60 * 60 });
          tokenData.promoCodeIssued = promoCode;
        }

        // Одноразово сгенерированный непрозрачный токен позволяет предзаполнить форму,
        // не помещая имя и email в URL письма или историю браузера.
        feedbackPrefillToken = crypto.randomUUID().replace(/-/g, "");
        await env.TEST_TOKENS.put("feedback-prefill:" + feedbackPrefillToken, JSON.stringify({
          name: String(name || "").trim(),
          email: String(email || "").trim().toLowerCase(),
          createdAt: Date.now()
        }), { expirationTtl: 45 * 24 * 60 * 60 });

        // Связываем промокод с email заказа, чтобы форму ОС можно было заполнить позже по ссылке из письма.
        const normalizedEmail = String(email || "").trim().toLowerCase();
        if (promoCode && normalizedEmail) {
          const promoKey = "promo:" + promoCode;
          const promoRaw = await env.TEST_TOKENS.get(promoKey);
          if (promoRaw) {
            const promoRecord = JSON.parse(promoRaw);
            promoRecord.email = normalizedEmail;
            promoRecord.issuedAt = Number(promoRecord.issuedAt || promoRecord.createdAt || Date.now());
            const promoTtl = Math.max(60, Math.floor(((promoRecord.expiresAt || (Date.now() + 45 * 24 * 60 * 60 * 1000)) - Date.now()) / 1000));
            await env.TEST_TOKENS.put(promoKey, JSON.stringify(promoRecord), { expirationTtl: promoTtl });

            const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedEmail));
            const emailHash = Array.from(new Uint8Array(hashBuffer), byte => byte.toString(16).padStart(2, "0")).join("");
            const emailIndexKey = "promo-email:" + emailHash;
            const indexRaw = await env.TEST_TOKENS.get(emailIndexKey);
            const index = indexRaw ? JSON.parse(indexRaw) : [];
            if (!index.some(item => item && item.code === promoCode)) {
              index.push({ code: promoCode, createdAt: Number(promoRecord.issuedAt || Date.now()) });
            }
            await env.TEST_TOKENS.put(emailIndexKey, JSON.stringify(index), { expirationTtl: promoTtl });
          }
        }
        await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
        const archiveKey = "completed-order:" + token;
        let previousArchive = {};
        try { previousArchive = JSON.parse(await env.TEST_TOKENS.get(archiveKey) || "{}"); } catch {}
        await env.TEST_TOKENS.put(archiveKey, JSON.stringify({
          ...previousArchive,
          email: String(email || "").trim().toLowerCase(),
          productKey: tokenData.productKey || previousArchive.productKey || null,
          productTitle: tokenData.productTitle || previousArchive.productTitle || null,
          studentName: tokenData.studentName || previousArchive.studentName || name || null,
          token,
          isCompleted: true,
          completedAt: tokenData.completedAt || previousArchive.completedAt || new Date().toISOString(),
          paidAt: tokenData.paidAt || previousArchive.paidAt || null,
          linkExpiresAt: tokenData.linkExpiresAt,
          reportReady: true,
          promoCodeIssued: promoCode || previousArchive.promoCodeIssued || null
        }), { expirationTtl: 3888000 });
        scheduleOrderSync(context, { env, token, order: tokenData, event: "diagnostic_completed" });
    }

    // Отдельный бот результатов получает PDF и ссылку на сохранённую диагностику.
    if (env.TELEGRAM_RESULTS_BOT_TOKEN && env.TG_CHAT_ID && (!tokenData.resultsTelegramSentAt || Number(tokenData.resultsTelegramReportVersion || 0) < reportVersion)) {
      try {
        const testFiles = {
          '7': 'test_7_basic.html', '7_basic': 'test_7_basic.html', '7_advanced': 'test_7_advanced.html',
          '7_basic_v2': 'test_7_basic_v2.html', '7_advanced_v2': 'test_7_advanced_v2.html',
          '8': 'test_8_basic.html', '8_basic': 'test_8_basic.html', '8_advanced': 'test_8_advanced.html',
          '9': 'test_9_basic.html', '9_basic': 'test_9_basic.html', '9_advanced': 'test_9_advanced.html',
          '10': 'test_10_basic.html', '10_basic': 'test_10_basic.html', '10_advanced': 'test_10_advanced.html',
          '11': 'test_11_basic.html', '11_basic': 'test_11_basic.html', '11_advanced': 'test_11_advanced.html'
        };
        const testUrl = 'https://reshai360.ru/' + (testFiles[tokenData.productKey] || 'index.html') + '?token=' + encodeURIComponent(token);
        const promoRaw = promoCode ? await env.TEST_TOKENS.get("promo:" + promoCode) : null;
        const issuedPromo = promoRaw ? JSON.parse(promoRaw) : null;
        const expiresText = issuedPromo?.expiresAt
          ? new Date(issuedPromo.expiresAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Moscow" })
          : "не указан";
        const tgFormData = new FormData();
        tgFormData.append("chat_id", env.TG_CHAT_ID);
        tgFormData.append("caption", [
          '📊 ДИАГНОСТИКА ЗАВЕРШЕНА — РЕШАЙ360',
          'Имя: ' + (name || 'Не указано'),
          'Email: ' + (email || 'Не указан'),
          'Открыть диагностику или итоговые результаты: ' + testUrl,
          'Результат: ' + resultSummary + '; всего заданий: ' + totalNumber,
          'Новый промокод: ' + (promoCode || 'не выдан'),
          'Скидка: ' + (issuedPromo ? Number(issuedPromo.discountPercent || 10) + '%' : '—'),
          'Действует до: ' + expiresText
        ].join('\n'));
        tgFormData.append("document", pdfFile, `Отчёт_${safeName}.pdf`);
        const tgResponse = await fetch(
          'https://api.telegram.org/bot' + env.TELEGRAM_RESULTS_BOT_TOKEN + '/sendDocument',
          { method: "POST", body: tgFormData }
        );
        const tgResult = await tgResponse.json().catch(() => ({}));
        if (!tgResponse.ok || tgResult.ok !== true) {
          tokenData.resultsTelegramStatus = "Ошибка";
          tokenData.resultsTelegramError = JSON.stringify(tgResult).slice(0, 700);
          await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
          scheduleOrderSync(context, { env, token, order: tokenData, event: "report_telegram_failed" });
          console.error("Telegram results notification error:", JSON.stringify(tgResult).slice(0, 1000));
        } else {
          const sentDocument = tgResult.result && tgResult.result.document ? tgResult.result.document : {};
          const sentMessage = tgResult.result || {};
          const sentChat = sentMessage.chat || {};
          tokenData.resultsTelegramSentAt = new Date().toISOString();
          tokenData.resultsTelegramStatus = "Отправлен";
          tokenData.resultsTelegramError = null;
          tokenData.resultsTelegramReportVersion = reportVersion;
          if (sentDocument.file_id) tokenData.resultsTelegramFileId = sentDocument.file_id;
          if (sentDocument.file_unique_id) tokenData.resultsTelegramFileUniqueId = sentDocument.file_unique_id;
          if (sentMessage.message_id) tokenData.resultsTelegramMessageId = sentMessage.message_id;
          if (sentChat.id !== undefined) tokenData.resultsTelegramChatId = String(sentChat.id);
          if (sentChat.username && sentMessage.message_id) {
            tokenData.resultsTelegramMessageLink = "https://t.me/" + sentChat.username + "/" + sentMessage.message_id;
          } else if (String(sentChat.id || "").startsWith("-100") && sentMessage.message_id) {
            tokenData.resultsTelegramMessageLink = "https://t.me/c/" + String(sentChat.id).slice(4) + "/" + sentMessage.message_id;
          }
          await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
          scheduleOrderSync(context, { env, token, order: tokenData, event: "report_sent" });
        }
      } catch (tgErr) {
        tokenData.resultsTelegramStatus = "Ошибка";
        tokenData.resultsTelegramError = String(tgErr && tgErr.message || tgErr).slice(0, 700);
        await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
        scheduleOrderSync(context, { env, token, order: tokenData, event: "report_telegram_failed" });
        console.error("Telegram results notification error:", tgErr);
      }
    }

    // Если клиент подтвердил email в боте поддержки, отправляем PDF, а затем отдельное сообщение с промокодами.
    if (env.TELEGRAM_SUPPORT_BOT_TOKEN) {
      try {
        const sentTo = Array.isArray(tokenData.supportTelegramSentTo) ? tokenData.supportTelegramSentTo : [];
        const promoSentTo = Array.isArray(tokenData.supportPromoSentTo) ? tokenData.supportPromoSentTo : [];
        const page = await env.TEST_TOKENS.list({ prefix: "support-email:", limit: 1000 });
        for (const item of page.keys || []) {
          const clientChatId = item.name.slice("support-email:".length);
          if (!clientChatId) continue;
          const clientEmail = String(await env.TEST_TOKENS.get(item.name) || "").trim().toLowerCase();
          if (!clientEmail || clientEmail !== email.trim().toLowerCase()) continue;
          try {
            let pdfDelivered = sentTo.includes(clientChatId);
            if (!pdfDelivered) {
              const supportForm = new FormData();
              supportForm.append("chat_id", clientChatId);
              supportForm.append("caption", "Ваш PDF-отчёт по завершённой диагностике Решай360.");
              supportForm.append("document", pdfFile, `Отчёт_${safeName}.pdf`);
              const supportResponse = await fetch(
                "https://api.telegram.org/bot" + env.TELEGRAM_SUPPORT_BOT_TOKEN + "/sendDocument",
                { method: "POST", body: supportForm }
              );
              const supportResult = await supportResponse.json().catch(() => ({}));
              if (supportResponse.ok && supportResult.ok === true) {
                sentTo.push(clientChatId);
                tokenData.supportTelegramSentTo = sentTo;
                pdfDelivered = true;
                await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
              } else {
                console.error("Telegram support PDF delivery error:", JSON.stringify(supportResult).slice(0, 1000));
              }
            }
            if (pdfDelivered && !promoSentTo.includes(clientChatId)) {
              const promoSent = await sendAutomaticSupportPromo(env, clientChatId, email, feedbackPrefillToken);
              if (promoSent) {
                promoSentTo.push(clientChatId);
                tokenData.supportPromoSentTo = promoSentTo;
                await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
              }
            }
          } catch (supportError) {
            console.error("Telegram support PDF/promo delivery error:", supportError);
          }
        }
      } catch (supportListError) {
        console.error("Telegram support chat lookup error:", supportListError);
      }
    }

    if (!env.RESEND_API_KEY) emailError = "На сервере не настроен ключ почтового сервиса.";
    else if (!email) emailError = "В заказе не указан адрес электронной почты.";

    if (emailError) {
      tokenData.reportEmailStatus = "Ошибка";
      tokenData.reportEmailError = emailError;
    }

    if (env.RESEND_API_KEY && email && (!tokenData.reportEmailSentAt || forceEmail)) {
      tokenData.reportEmailStatus = "Ожидает отправки";
      tokenData.reportEmailAttemptAt = new Date().toISOString();
      tokenData.reportEmailError = null;
      await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
      try {
        const bytes = new Uint8Array(await pdfFile.arrayBuffer());
        let binary = "";

        for (let i = 0; i < bytes.length; i += 32768) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        }

        const base64Pdf = btoa(binary);

        const emailResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "Решай360 <info@reshai360.ru>",
            to: [email],
            subject: `Результаты диагностики по математике — ${name || "ученик"}`,
            html: `
              <!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
              <body style="margin:0;padding:0;background:#eef2ff;font-family:Arial,Helvetica,sans-serif;color:#172033;">
                <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Диагностика завершена — PDF-отчёт во вложении, промокод указан отдельно в письме.</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:linear-gradient(135deg,#eef2ff,#f5f3ff);padding:28px 12px;">
                  <tr><td align="center">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 12px 35px rgba(30,41,59,.12);">
                      <tr><td style="padding:28px 30px;background:linear-gradient(120deg,#312e81,#4f46e5,#0891b2);color:#ffffff;">
                        <div style="font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;opacity:.85;">РЕШАЙ360</div>
                        <h1 style="margin:12px 0 6px;font-size:25px;line-height:1.25;">Диагностика завершена!</h1>
                        <p style="margin:0;font-size:14px;line-height:1.6;color:#e0e7ff;">Теперь вы знаете, что уже получается хорошо и что стоит повторить.</p>
                      </td></tr>
                      <tr><td style="padding:28px 30px 10px;">
                        <p style="margin:0 0 14px;font-size:16px;">Здравствуйте, <strong>${safeNameHtml}</strong>!</p>
                        <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#475569;">Спасибо, что прошли диагностику на платформе Решай360. Ваш персональный PDF-отчёт с результатами и рекомендациями прикреплён к этому письму.</p>
                        <div style="padding:16px 18px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;">
                          <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:700;">Ваш результат</div>
                          <div style="margin-top:6px;font-size:24px;font-weight:800;color:#312e81;">${resultSummary}</div>
                          <div style="margin-top:4px;font-size:12px;color:#64748b;">Всего заданий: ${totalNumber}; без ответа: ${totalNumber - evaluatedNumber}</div>
                        </div>
                        ${promoCode ? `
                        <div style="margin-top:18px;padding:20px;border-radius:16px;background:#eef2ff;border:1px solid #c7d2fe;">
                          <div style="font-size:13px;color:#4338ca;font-weight:800;text-transform:uppercase;letter-spacing:.8px;">🎁 Подарок за прохождение</div>
                          <div style="margin:10px 0;padding:12px;background:#ffffff;border:1px dashed #818cf8;border-radius:10px;text-align:center;font-size:22px;letter-spacing:2px;font-weight:800;color:#312e81;">${promoCode}</div>
                          <p style="margin:0;font-size:14px;line-height:1.65;color:#3730a3;">Промокод даёт <strong>скидку 10%</strong> на следующую диагностику. Используйте его сами или поделитесь с другом. Код одноразовый и действует 45 дней.</p>
                          <p style="margin:12px 0 0;font-size:13px;line-height:1.65;color:#4338ca;">Оставьте отзыв, пожелание или идею — скидка по промокоду увеличится до <strong>15%</strong>. <a href="https://reshai360.ru/index.html?feedback_token=${feedbackPrefillToken}#feedback" style="color:#4338ca;text-decoration:underline;font-weight:700;">Открыть форму обратной связи</a>.</p>
                        </div>` : ""}
                        <p style="margin:22px 0 0;font-size:15px;line-height:1.7;color:#475569;">С заботой о знаниях и хвостиках,<br><strong>Команда Решай360</strong></p>
                      </td></tr>
                      <tr><td style="padding:22px 30px;background:#0f172a;color:#cbd5e1;">
                        <div style="font-size:13px;line-height:1.7;">Помогаем хвостикам вместе: 100 ₽ с каждой оплаченной диагностики направляем в приют «Собачий мир» в Красноярске.</div>
                        <div style="margin-top:12px;font-size:12px;"><a href="https://reshai360.ru" style="color:#a5b4fc;text-decoration:none;">reshai360.ru</a> &nbsp;·&nbsp; <a href="https://t.me/sobachiy_mir_krsk" style="color:#fbbf24;text-decoration:none;">Канал приюта</a></div>
                      </td></tr>
                    </table>
                    <p style="max-width:600px;margin:16px auto 0;font-size:11px;line-height:1.6;color:#64748b;text-align:center;">Это автоматическое письмо. Пожалуйста, не отвечайте на него: ответы на этот адрес не отслеживаются. Если нужна помощь, воспользуйтесь контактами на сайте Решай360.</p>
                  </td></tr>
                </table>
              </body></html>
            `,
            attachments: [
              {
                filename: `Отчет_${safeName}.pdf`,
                content: base64Pdf
              }
            ]
          })
        });

        if (!emailResponse.ok) {
          emailError = (await emailResponse.text()).slice(0, 700);
          tokenData.reportEmailStatus = "Ошибка";
          tokenData.reportEmailError = emailError || ("HTTP " + emailResponse.status);
          await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
          console.error("Resend API error:", emailError);
        } else {
          const resendResult = await emailResponse.json().catch(() => ({}));
          emailId = resendResult.id || null;
          emailSent = true;
          tokenData.reportEmailSentAt = new Date().toISOString();
          tokenData.reportEmailStatus = "Отправлено";
          tokenData.reportEmailError = null;
          tokenData.email = email;
          if (emailId) tokenData.reportEmailId = emailId;
          await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
        }
      } catch (resendErr) {
        emailError = String(resendErr && resendErr.message || resendErr).slice(0, 500);
        tokenData.reportEmailStatus = "Ошибка";
        tokenData.reportEmailError = emailError;
        await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
        console.error("Resend email error:", resendErr);
      }
    } else if (tokenData.reportEmailSentAt) {
      tokenData.reportEmailStatus = "Отправлено";
      tokenData.reportEmailError = null;
    }

    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
    scheduleOrderSync(context, {
      env,
      token,
      order: tokenData,
      event: tokenData.reportEmailStatus === "Отправлено" ? "report_email_sent" : "report_email_status_updated"
    });

    return Response.json({ success: true, promoCode, emailSent, emailId, feedbackUrl: feedbackPrefillToken ? `https://reshai360.ru/index.html?feedback_token=${feedbackPrefillToken}#feedback` : null, emailPreviouslyAccepted: Boolean(tokenData.reportEmailSentAt && !emailSent && !forceEmail), emailError, pdfBytes: Number(pdfFile.size || 0) });
  } catch (err) {
    console.error("Send report global error:", err);

    return Response.json(
      { success: false, message: err.message || "Ошибка отправки отчёта" },
      { status: 500 }
    );
  }
}

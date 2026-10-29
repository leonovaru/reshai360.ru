export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const token = String(body.token || "").trim();
    const category = String(body.category || "Другое").trim().slice(0, 100);
    const message = String(body.message || "").trim().slice(0, 5000);
    const name = String(body.name || "Не указано").trim().slice(0, 200);
    const email = String(body.email || "").trim().slice(0, 320);
    const promoCode = String(body.promoCode || "").trim().toUpperCase();
    const source = token ? "completed_test" : String(body.source || "website").slice(0, 50);

    if (!message || message.length < 5 || !name || !email) {
      return Response.json({ success: false, message: "Укажите имя, email и напишите сообщение хотя бы из 5 символов." }, { status: 400 });
    }
    if (!env.TEST_TOKENS) {
      return Response.json({ success: false, message: "Хранилище временно недоступно. Попробуйте позже." }, { status: 503 });
    }

    let tokenData = null;
    let promo = null;
    let promoKey = null;
    let promoCodeToUpgrade = null;
    let feedbackId = crypto.randomUUID();
    let feedbackKey = "feedback:" + feedbackId;
    const normalizedEmail = email.toLowerCase();
    const now = Date.now();

    if (token) {
      const tokenRaw = await env.TEST_TOKENS.get(token);
      if (!tokenRaw) {
        return Response.json({ success: false, message: "Ссылка на диагностику истекла. Оставьте обратную связь через форму на сайте." }, { status: 403 });
      }
      tokenData = JSON.parse(tokenRaw);
      if (!tokenData.isCompleted) {
        return Response.json({ success: false, message: "Обратную связь по этой диагностике можно оставить после её завершения." }, { status: 403 });
      }
      if (String(tokenData.email || "").trim().toLowerCase() && String(tokenData.email).trim().toLowerCase() !== normalizedEmail) {
        return Response.json({ success: false, message: "Укажите email, который использовался при заказе диагностики." }, { status: 403 });
      }
      feedbackKey = "feedback:" + token;
      const previousFeedback = await env.TEST_TOKENS.get(feedbackKey);
      if (previousFeedback) {
        return Response.json({ success: true, upgraded: false, alreadySubmitted: true, emailSent: false, message: "Обратная связь по этой диагностике уже отправлена." });
      }
    }

    // Сначала ищем индекс выданных промокодов по нормализованному email.
    const emailHashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedEmail));
    const emailHash = Array.from(new Uint8Array(emailHashBuffer), byte => byte.toString(16).padStart(2, "0")).join("");
    const emailIndexKey = "promo-email:" + emailHash;
    const indexRaw = await env.TEST_TOKENS.get(emailIndexKey);
    let indexedCodes = indexRaw ? JSON.parse(indexRaw) : [];
    if (!Array.isArray(indexedCodes)) indexedCodes = [];

    // Для старых заказов без индекса ищем ещё живые записи диагностики в KV.
    if (typeof env.TEST_TOKENS.list === "function") {
      let cursor;
      do {
        const page = await env.TEST_TOKENS.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const entry of page.keys || []) {
          const key = entry.name;
          if (!key || key.startsWith("promo:") || key.startsWith("promo-email:") || key.startsWith("feedback:") || key.startsWith("consent:") || key.startsWith("partner:")) continue;
          const raw = await env.TEST_TOKENS.get(key);
          if (!raw) continue;
          let record;
          try { record = JSON.parse(raw); } catch { continue; }
          if (String(record.email || "").trim().toLowerCase() !== normalizedEmail || !record.promoCodeIssued) continue;
          indexedCodes.push({ code: String(record.promoCodeIssued).toUpperCase(), createdAt: Number(record.completedAt || record.createdAt || 0) });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }

    const seenCodes = new Set();
    const candidates = [];
    for (const item of indexedCodes) {
      const code = String(item?.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9-]{5,24}$/.test(code) || seenCodes.has(code)) continue;
      seenCodes.add(code);
      const raw = await env.TEST_TOKENS.get("promo:" + code);
      if (!raw) continue;
      let record;
      try { record = JSON.parse(raw); } catch { continue; }
      // Не позволяем повысить промокод, принадлежащий другому email.
      if (record.email && String(record.email).trim().toLowerCase() !== normalizedEmail) continue;
      if (record.used || (record.expiresAt && record.expiresAt <= now) || (record.reservedUntil && record.reservedUntil > now)) continue;
      candidates.push({ code, key: "promo:" + code, record, createdAt: Number(record.issuedAt || record.createdAt || item.createdAt || 0) });
    }

    // Если токен диагностики ещё жив, его промокод тоже учитываем — это помогает старым заказам.
    if (tokenData?.promoCodeIssued && !seenCodes.has(String(tokenData.promoCodeIssued).toUpperCase())) {
      const code = String(tokenData.promoCodeIssued).toUpperCase();
      const raw = await env.TEST_TOKENS.get("promo:" + code);
      if (raw) {
        const record = JSON.parse(raw);
        if ((!record.email || String(record.email).trim().toLowerCase() === normalizedEmail) &&
            !record.used && !(record.expiresAt && record.expiresAt <= now) &&
            !(record.reservedUntil && record.reservedUntil > now)) {
          candidates.push({ code, key: "promo:" + code, record, createdAt: Number(record.issuedAt || record.createdAt || 0) });
        }
      }
    }

    // Повышаем только самый поздний из активных промокодов клиента.
    candidates.sort((a, b) => b.createdAt - a.createdAt);
    if (candidates.length) {
      promoCodeToUpgrade = candidates[0].code;
      promoKey = candidates[0].key;
      promo = candidates[0].record;
      if (Number(promo.discountPercent || 10) < 15 && !promo.feedbackUpgrade) {
        // К этому моменту выбран именно последний активный промокод по email.
      } else {
        promo = null;
        promoKey = null;
        promoCodeToUpgrade = null;
      }
    }
    const oldPercent = Number(promo?.discountPercent);
    const promoDiscountBefore = promo ? (Number.isFinite(oldPercent) && oldPercent > 0 ? oldPercent + "%" : (Number(promo.discount) || 90) + " ₽") : null;
    const upgradedNow = Boolean(promo && Number(promo.discountPercent || 10) < 15 && !promo.feedbackUpgrade);
    const feedback = {
      id: feedbackId,
      createdAt: new Date().toISOString(),
      source,
      name,
      email,
      productKey: tokenData ? (tokenData.productKey || "unknown") : null,
      category,
      message,
      promoCode: promoCodeToUpgrade || promoCode || null,
      promoDiscountBefore,
      promoDiscountAfter: promo ? "15%" : null
    };

    if (promo && promoKey && upgradedNow) {
      promo.discountPercent = 15;
      delete promo.discount;
      promo.feedbackUpgrade = true;
      promo.feedbackAt = Date.now();
      const ttl = Math.max(60, Math.floor(((promo.expiresAt || (Date.now() + 45 * 24 * 60 * 60 * 1000)) - Date.now()) / 1000));
      await env.TEST_TOKENS.put(promoKey, JSON.stringify(promo), { expirationTtl: ttl });
    }

    // Сначала фиксируем повышение скидки, затем сохраняем отзыв: повторный запрос сможет безопасно повторить повышение, если KV-операция завершилась ошибкой.
    await env.TEST_TOKENS.put(feedbackKey, JSON.stringify(feedback), { expirationTtl: 31536000 });

    let telegramSent = false;
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
      const lines = [
        "💬 Новая обратная связь — Решай360",
        "Источник: " + source,
        "Имя: " + name,
        "Email: " + email,
        "Диагностика: " + (tokenData ? (tokenData.productKey || "не указана") : "не привязана"),
        "Категория: " + category,
        (promoCodeToUpgrade || promoCode) ? ("Промокод " + (promoCodeToUpgrade || promoCode) + (promo ? (upgradedNow ? " повышен до 15%" : " — текущая скидка " + (promo.discountPercent || 10) + "%") : "")) : "",
        "",
        "Сообщение:",
        message
      ].filter(Boolean);
      try {
        const response = await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: lines.join("\n") })
        });
        telegramSent = response.ok;
        if (!response.ok) console.error("Telegram feedback error:", await response.text());
      } catch (error) {
        console.error("Telegram feedback send error:", error);
      }
    }

    let emailSent = false;
    if (promo && upgradedNow && env.RESEND_API_KEY && email) {
      try {
        const safePromoCode = promoCodeToUpgrade.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const safeName = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const promoExpiresText = promo?.expiresAt ? new Date(promo.expiresAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" }) : "до окончания срока действия промокода";
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Решай360 <no-reply@reshai360.ru>",
            to: [email],
            subject: "Ваш промокод Решай360 теперь даёт скидку 15%",
            html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head>
              <body style="margin:0;padding:0;background:#eef2ff;font-family:Arial,Helvetica,sans-serif;color:#172033;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2ff;padding:28px 12px;"><tr><td align="center">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:18px;overflow:hidden;">
                    <tr><td style="padding:26px 30px;background:linear-gradient(120deg,#312e81,#4f46e5,#0891b2);color:#fff;"><div style="font-size:13px;font-weight:700;letter-spacing:2px;">РЕШАЙ360</div><h1 style="margin:12px 0 0;font-size:24px;">Спасибо за вашу идею!</h1></td></tr>
                    <tr><td style="padding:28px 30px;"><p>Здравствуйте, <strong>${safeName}</strong>!</p><p style="line-height:1.7;color:#475569;">Вы помогаете сделать Решай360 полезнее. Как и обещали, мы увеличили скидку по вашему промокоду.</p>
                      <div style="padding:20px;border-radius:14px;background:#eef2ff;border:1px solid #c7d2fe;text-align:center;"><div style="font-size:12px;color:#4338ca;font-weight:800;letter-spacing:1px;">ВАШ ПРОМОКОД</div><div style="margin:12px 0;font-size:24px;font-weight:800;letter-spacing:2px;color:#312e81;">${safePromoCode}</div><div style="font-size:20px;font-weight:800;color:#4338ca;">Скидка 15%</div></div>
                      <p style="font-size:14px;line-height:1.7;color:#475569;">Код одноразовый. Используйте его сами или поделитесь с другом до <strong>${promoExpiresText}</strong>.</p><p>Спасибо, что вы с нами!<br><strong>Команда Решай360</strong></p></td></tr>
                    <tr><td style="padding:20px 30px;background:#0f172a;color:#cbd5e1;font-size:12px;line-height:1.7;"><a href="https://reshai360.ru" style="color:#a5b4fc;">reshai360.ru</a><p style="margin:12px 0 0;">Это автоматическое письмо. Не отвечайте на него: ответы на этот адрес не отслеживаются.</p></td></tr>
                  </table></td></tr></table></body></html>`
          })
        });
        emailSent = response.ok;
        if (!response.ok) console.error("Feedback confirmation email error:", await response.text());
      } catch (error) {
        console.error("Feedback confirmation email send error:", error);
      }
    }

    return Response.json({
      success: true,
      telegramSent,
      emailSent,
      upgraded: Boolean(promo && upgradedNow),
      promoPercent: promo ? Number(promo.discountPercent || 15) : null,
      promoMessage: promo && upgradedNow ? "Скидка по последнему активному промокоду повышена до 15%. Письмо отправлено, если почта указана верно." : "Спасибо! Сообщение сохранено — мы используем ваши идеи для улучшения Решай360."
    });
  } catch (error) {
    console.error("Submit feedback error:", error);
    return Response.json({ success: false, message: "Не удалось сохранить обратную связь. Попробуйте позже." }, { status: 500 });
  }
}

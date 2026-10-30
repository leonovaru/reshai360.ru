
export async function onRequestPost({ request, env }) {
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
            stats: parsed.stats && typeof parsed.stats === "object" ? parsed.stats : {}
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
    if (tokenData.isPaid !== true) {
      return Response.json(
        { success: false, message: "Отчёт доступен только после подтверждения оплаты." },
        { status: 403 }
      );
    }

    // Используем контактные данные из серверной записи заказа.
    const email = String(tokenData.email || submittedEmail).trim();
    const name = String(tokenData.studentName || submittedName).trim();

    if (!pdfFile || typeof pdfFile.arrayBuffer !== "function") {
      return Response.json(
        { success: false, message: "PDF-файл не получен" },
        { status: 400 }
      );
    }

    const scoreNumber = Number(score);
    const totalNumber = Number(total);

    if (
      !Number.isFinite(scoreNumber) ||
      !Number.isFinite(totalNumber) ||
      totalNumber <= 0 ||
      scoreNumber < 0 ||
      scoreNumber > totalNumber
    ) {
      return Response.json(
        { success: false, message: "Некорректный результат теста" },
        { status: 400 }
      );
    }

    const percent = Math.round((scoreNumber / totalNumber) * 100);
    const safeName = String(name || "Ученик").replace(/[\\/:*?"<>|]/g, "_");
    const safeNameHtml = String(name || "ученик").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\x27/g, "&#39;");

    let promoCode = null;
    let emailSent = false;
    let emailError = null;
    {
        tokenData.isCompleted = true;
        if (answersSnapshot) tokenData.answersSnapshot = answersSnapshot;
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
        const feedbackPrefillToken = crypto.randomUUID().replace(/-/g, "");
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
        await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
    }

    // Повторный запрос отчёта не должен повторно отправлять уже доставленный файл.
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID && !tokenData.telegramSentAt) {
      try {
        const tgFormData = new FormData();
        tgFormData.append("chat_id", env.TG_CHAT_ID);
        tgFormData.append(
          "caption",
          `🎯 Пройдена диагностика!\nУченик: ${name || "Не указано"}\nEmail: ${email || "Не указан"}\nРезультат: ${scoreNumber} из ${totalNumber} (${percent}%)${promoCode ? `\n🎁 Промокод на следующую диагностику: ${promoCode} (скидка 10%)` : ""}`
        );
        tgFormData.append("document", pdfFile, `Отчет_${safeName}.pdf`);

        const tgResponse = await fetch(
          `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendDocument`,
          { method: "POST", body: tgFormData }
        );

        if (!tgResponse.ok) {
          console.error("Telegram API error:", await tgResponse.text());
        } else {
          tokenData.telegramSentAt = new Date().toISOString();
          await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
        }
      } catch (tgErr) {
        console.error("Telegram send error:", tgErr);
      }
    }

    if (!env.RESEND_API_KEY) emailError = "На сервере не настроен ключ почтового сервиса.";
    else if (!email) emailError = "В заказе не указан адрес электронной почты.";

    if (env.RESEND_API_KEY && email && (!tokenData.reportEmailSentAt || forceEmail)) {
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
                          <div style="margin-top:6px;font-size:24px;font-weight:800;color:#312e81;">${scoreNumber} из ${totalNumber} · ${percent}%</div>
                        </div>
                        ${promoCode ? `
                        <div style="margin-top:18px;padding:20px;border-radius:16px;background:#eef2ff;border:1px solid #c7d2fe;">
                          <div style="font-size:13px;color:#4338ca;font-weight:800;text-transform:uppercase;letter-spacing:.8px;">🎁 Подарок за прохождение</div>
                          <div style="margin:10px 0;padding:12px;background:#ffffff;border:1px dashed #818cf8;border-radius:10px;text-align:center;font-size:22px;letter-spacing:2px;font-weight:800;color:#312e81;">${promoCode}</div>
                          <p style="margin:0;font-size:14px;line-height:1.65;color:#3730a3;">Промокод даёт <strong>скидку 10%</strong> на следующую диагностику. Используйте его сами или поделитесь с другом. Код одноразовый и действует 45 дней.</p>
                          <p style="margin:12px 0 0;font-size:13px;line-height:1.65;color:#4338ca;">Оставьте отзыв, пожелание или идею — скидка по промокоду увеличится до <strong>15%</strong>. <a href="https://reshai360.ru/?feedback_token=${feedbackPrefillToken}#feedback" style="color:#4338ca;text-decoration:underline;font-weight:700;">Открыть форму обратной связи</a>.</p>
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
          console.error("Resend API error:", emailError);
        } else {
          emailSent = true;
          tokenData.reportEmailSentAt = new Date().toISOString();
          await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
        }
      } catch (resendErr) {
        emailError = String(resendErr && resendErr.message || resendErr).slice(0, 500);
        console.error("Resend email error:", resendErr);
      }
    }

    return Response.json({ success: true, promoCode, emailSent, emailPreviouslyAccepted: Boolean(tokenData.reportEmailSentAt && !emailSent && !forceEmail), emailError, pdfBytes: Number(pdfFile.size || 0) });
  } catch (err) {
    console.error("Send report global error:", err);

    return Response.json(
      { success: false, message: err.message || "Ошибка отправки отчёта" },
      { status: 500 }
    );
  }
}

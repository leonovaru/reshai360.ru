
export async function onRequestPost({ request, env }) {
  try {
    const formData = await request.formData();

    const token = formData.get("token");
    const email = formData.get("email");
    const name = formData.get("name");
    const score = formData.get("score");
    const total = formData.get("total");
    const pdfFile = formData.get("document");

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
      totalNumber <= 0
    ) {
      return Response.json(
        { success: false, message: "Некорректный результат теста" },
        { status: 400 }
      );
    }

    const percent = Math.round((scoreNumber / totalNumber) * 100);
    const safeName = String(name || "Ученик").replace(/[\\/:*?"<>|]/g, "_");

    let promoCode = null;
    let emailSent = false;
    if (token && env.TEST_TOKENS) {
      const tokenDataRaw = await env.TEST_TOKENS.get(token);
      if (tokenDataRaw) {
        const tokenData = JSON.parse(tokenDataRaw);
        tokenData.isCompleted = true;

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
            discount: 90,
            createdAt: Date.now(),
            expiresAt: Date.now() + 180 * 24 * 60 * 60 * 1000,
            used: false,
            reservedBy: null,
            reservedUntil: null
          }), { expirationTtl: 15552000 });
          tokenData.promoCodeIssued = promoCode;
        }
        await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
      }
    }

    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
      try {
        const tgFormData = new FormData();
        tgFormData.append("chat_id", env.TG_CHAT_ID);
        tgFormData.append(
          "caption",
          `🎯 Пройдена диагностика!\nУченик: ${name || "Не указано"}\nEmail: ${email || "Не указан"}\nРезультат: ${scoreNumber} из ${totalNumber} (${percent}%)${promoCode ? `\n🎁 Промокод на следующую диагностику: ${promoCode} (скидка 90 ₽)` : ""}`
        );
        tgFormData.append("document", pdfFile, `Отчет_${safeName}.pdf`);

        const tgResponse = await fetch(
          `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendDocument`,
          { method: "POST", body: tgFormData }
        );

        if (!tgResponse.ok) {
          console.error("Telegram API error:", await tgResponse.text());
        }
      } catch (tgErr) {
        console.error("Telegram send error:", tgErr);
      }
    }

    if (env.RESEND_API_KEY && email) {
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
              <p>Здравствуйте, <b>${name || "ученик"}</b>!</p>
              <p>Вы завершили диагностику знаний по математике на платформе <b>Решай360</b>.</p>
              <p>Во вложении находится ваш PDF-отчёт с результатами и рекомендациями.</p>
              ${promoCode ? `<p><b>Ваш промокод на следующую диагностику: ${promoCode}</b></p><p>Промокод даёт скидку 90 ₽. Вы можете использовать его сами при следующем заказе или передать другу. Использовать промокод можно один раз; срок действия — 180 дней.</p>` : ""}
              <p>С уважением,<br>Команда Решай360<br>
              <a href="https://reshai360.ru">reshai360.ru</a></p>
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
          console.error("Resend API error:", await emailResponse.text());
        } else { emailSent = true; }
      } catch (resendErr) {
        console.error("Resend email error:", resendErr);
      }
    }

    return Response.json({ success: true, promoCode, emailSent });
  } catch (err) {
    console.error("Send report global error:", err);

    return Response.json(
      { success: false, message: err.message || "Ошибка отправки отчёта" },
      { status: 500 }
    );
  }
}

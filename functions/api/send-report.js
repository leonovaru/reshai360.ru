
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

    if (token && env.TEST_TOKENS) {
      const tokenDataRaw = await env.TEST_TOKENS.get(token);

      if (tokenDataRaw) {
        const tokenData = JSON.parse(tokenDataRaw);
        tokenData.isCompleted = true;
        await env.TEST_TOKENS.put(token, JSON.stringify(tokenData));
      }
    }

    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
      try {
        const tgFormData = new FormData();
        tgFormData.append("chat_id", env.TG_CHAT_ID);
        tgFormData.append(
          "caption",
          `🎯 Пройдена диагностика!\nУченик: ${name || "Не указано"}\nEmail: ${email || "Не указан"}\nРезультат: ${scoreNumber} из ${totalNumber} (${percent}%)`
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
        }
      } catch (resendErr) {
        console.error("Resend email error:", resendErr);
      }
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error("Send report global error:", err);

    return Response.json(
      { success: false, message: err.message || "Ошибка отправки отчёта" },
      { status: 500 }
    );
  }
}

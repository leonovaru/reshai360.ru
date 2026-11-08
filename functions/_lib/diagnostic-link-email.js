import { getOrderExpirationTtl } from "./telegram-payment.js";
const TEST_FILES = {
  "7": "test_7_basic.html", "7_basic": "test_7_basic.html", "7_advanced": "test_7_advanced.html",
  "8": "test_8_basic.html", "8_basic": "test_8_basic.html", "8_advanced": "test_8_advanced.html",
  "9": "test_9_basic.html", "9_basic": "test_9_basic.html", "9_advanced": "test_9_advanced.html",
  "10": "test_10_basic.html", "10_basic": "test_10_basic.html", "10_advanced": "test_10_advanced.html",
  "11": "test_11_basic.html", "11_basic": "test_11_basic.html", "11_advanced": "test_11_advanced.html"
};

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function sendDiagnosticLinkEmail({ env, token, tokenData }) {
  if (tokenData.diagnosticLinkEmailSentAt) {
    tokenData.diagnosticLinkEmailStatus = "Отправлено";
    return { sent: true, alreadySent: true, id: tokenData.diagnosticLinkEmailId || null };
  }

  if (!tokenData.email || !env.RESEND_API_KEY) {
    const error = !tokenData.email ? "В заказе не указан адрес электронной почты." : "На сервере не настроен ключ почтового сервиса.";
    tokenData.diagnosticLinkEmailStatus = "Ошибка";
    tokenData.diagnosticLinkEmailError = error;
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), {
      expirationTtl: getOrderExpirationTtl(tokenData)
    });
    console.error("Diagnostic link email cannot be sent:", error);
    return { sent: false, configured: false, error };
  }

  const testFile = TEST_FILES[tokenData.productKey];
  if (!testFile) {
    const error = "Неизвестный тип диагностики: " + String(tokenData.productKey || "");
    tokenData.diagnosticLinkEmailStatus = "Ошибка";
    tokenData.diagnosticLinkEmailError = error;
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), {
      expirationTtl: getOrderExpirationTtl(tokenData)
    });
    console.error("Diagnostic link email skipped:", error);
    return { sent: false, configured: true, error };
  }

  const lastAttemptAt = Date.parse(tokenData.diagnosticLinkEmailAttemptAt || "");
  if (Number.isFinite(lastAttemptAt) && Date.now() - lastAttemptAt < 60 * 1000) {
    tokenData.diagnosticLinkEmailStatus = tokenData.diagnosticLinkEmailStatus || "Ожидает отправки";
    return { sent: false, configured: true, retryDeferred: true };
  }

  // Не чаще одного обращения к Resend в минуту для одного заказа:
  // success.html опрашивает статус платежа несколько раз подряд.
  tokenData.diagnosticLinkEmailAttemptAt = new Date().toISOString();
  tokenData.diagnosticLinkEmailStatus = "Ожидает отправки";
  tokenData.diagnosticLinkEmailError = null;
  tokenData.diagnosticUrl = "https://reshai360.ru/" + testFile + "?token=" + encodeURIComponent(token);
  await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), {
    expirationTtl: getOrderExpirationTtl(tokenData)
  });

  const diagnosticUrl = tokenData.diagnosticUrl;
  const studentName = String(tokenData.studentName || "").trim();
  const safeName = escapeHtml(studentName || "Здравствуйте");
  const greetingText = studentName ? "Здравствуйте, " + studentName + "!" : "Здравствуйте!";
  const textBody = greetingText + "\n\nОплата подтверждена. Перейдите по ссылке, чтобы начать диагностику:\n" + diagnosticUrl + "\n\nВажно: ссылка на диагностику действует 7 дней с момента оплаты. Пожалуйста, начните и завершите прохождение в течение этого времени.\n\nС заботой о знаниях и хвостиках,\nКоманда Решай360";
  const htmlBody = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#eef2ff;font-family:Arial,Helvetica,sans-serif;color:#172033;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:linear-gradient(135deg,#eef2ff,#f5f3ff);padding:28px 12px;"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 12px 35px rgba(30,41,59,.12);"><tr><td style="padding:28px 30px;background:linear-gradient(120deg,#312e81,#4f46e5,#0891b2);color:#fff;"><div style="font-size:13px;font-weight:700;letter-spacing:2px;">РЕШАЙ360</div><h1 style="margin:12px 0 0;font-size:25px;line-height:1.25;">Оплата подтверждена!</h1></td></tr><tr><td style="padding:28px 30px;"><p style="margin:0 0 16px;font-size:16px;">Здравствуйте, <strong>${safeName}</strong>!</p><p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#475569;">Спасибо за заказ. Ваша диагностика готова к прохождению. Нажмите на кнопку ниже, чтобы открыть её.</p><p style="margin:0 0 24px;text-align:center;"><a href="${diagnosticUrl}" style="display:inline-block;padding:14px 24px;border-radius:12px;background:linear-gradient(100deg,#4f46e5,#0891b2);color:#fff;text-decoration:none;font-size:15px;font-weight:700;">Перейти к диагностике</a></p><div style="padding:16px 18px;border-radius:14px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;"><p style="margin:0 0 6px;font-size:14px;font-weight:700;">Важно: ссылка на диагностику действует 7 дней.</p><p style="margin:0;font-size:14px;line-height:1.65;">Пожалуйста, начните и завершите прохождение в течение этого времени.</p></div><p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#475569;">С заботой о знаниях и хвостиках,<br><strong>Команда Решай360</strong></p></td></tr><tr><td style="padding:20px 30px;background:#0f172a;color:#cbd5e1;font-size:12px;"><a href="https://reshai360.ru" style="color:#a5b4fc;text-decoration:none;">reshai360.ru</a> · 100 ₽ с каждой оплаченной диагностики направляем в приют «Собачий мир».</td></tr></table></td></tr></table></body></html>`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Решай360 <info@reshai360.ru>",
        to: [String(tokenData.email).trim()],
        subject: "Ваша ссылка на диагностику Решай360",
        text: textBody,
        html: htmlBody
      })
    });

    if (!response.ok) {
      const error = (await response.text()).slice(0, 700) || ("HTTP " + response.status);
      tokenData.diagnosticLinkEmailStatus = "Ошибка";
      tokenData.diagnosticLinkEmailError = error;
      await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), {
        expirationTtl: getOrderExpirationTtl(tokenData)
      });
      console.error("Diagnostic link email error:", response.status, error);
      return { sent: false, configured: true, error };
    }

    const emailResult = await response.json().catch(() => ({}));
    tokenData.diagnosticLinkEmailSentAt = new Date().toISOString();
    tokenData.diagnosticLinkEmailId = emailResult.id || null;
    tokenData.diagnosticLinkEmailStatus = "Отправлено";
    tokenData.diagnosticLinkEmailError = null;
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), {
      expirationTtl: getOrderExpirationTtl(tokenData)
    });
    return { sent: true, configured: true, id: emailResult.id || null };
  } catch (error) {
    const message = String(error && error.message || error).slice(0, 700);
    tokenData.diagnosticLinkEmailStatus = "Ошибка";
    tokenData.diagnosticLinkEmailError = message;
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), {
      expirationTtl: getOrderExpirationTtl(tokenData)
    });
    console.error("Diagnostic link email error:", error);
    return { sent: false, configured: true, error: message };
  }
}


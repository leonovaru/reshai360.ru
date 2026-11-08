import { sendPaymentTelegramNotification, getOrderExpirationTtl, ORDER_ACCESS_TTL_MS } from "../_lib/telegram-payment.js";
import { scheduleOrderSync } from "../_lib/google-sheets.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const event = await request.json();
    const eventPaymentId = event.object && event.object.id;

    // При отмене платежа проверяем фактический статус в ЮKassa и сразу освобождаем промокод.
    if (event.event === 'payment.canceled' && eventPaymentId && env.YOKASSA_SHOP_ID && env.YOKASSA_SECRET_KEY && env.TEST_TOKENS) {
      const cancelCredentials = btoa(`${env.YOKASSA_SHOP_ID}:${env.YOKASSA_SECRET_KEY}`);
      const cancelResponse = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(eventPaymentId)}`, {
        headers: { 'Authorization': `Basic ${cancelCredentials}` }
      });
      if (!cancelResponse.ok) return new Response('Payment verification failed', { status: 502 });
      const canceledPayment = await cancelResponse.json();
      const canceledToken = canceledPayment.metadata && canceledPayment.metadata.token;
      if (canceledPayment.status === 'canceled' && canceledToken) {
        const orderRaw = await env.TEST_TOKENS.get(canceledToken);
        if (orderRaw) {
          const order = JSON.parse(orderRaw);
          if (order.paymentId === canceledPayment.id && order.isPaid !== true && order.promoCode) {
            const promoKey = 'promo:' + String(order.promoCode).toUpperCase();
            const promoRaw = await env.TEST_TOKENS.get(promoKey);
            if (promoRaw) {
              const promo = JSON.parse(promoRaw);
              if (promo.reservedBy === canceledToken && !promo.used) {
                promo.reservedBy = null;
                promo.reservedUntil = null;
                await env.TEST_TOKENS.put(promoKey, JSON.stringify(promo), { expirationTtl: 15552000 });
              }
            }
          }
        }
      }
      return new Response('OK', { status: 200 });
    }
    if (event.event !== 'payment.succeeded') return new Response('OK', { status: 200 });

    // Не доверяем телу входящего webhook: сверяем платёж напрямую с API ЮKassa.
    if (!eventPaymentId || !env.YOKASSA_SHOP_ID || !env.YOKASSA_SECRET_KEY || !env.TEST_TOKENS) {
      return new Response('Missing payment configuration', { status: 400 });
    }
    const credentials = btoa(`${env.YOKASSA_SHOP_ID}:${env.YOKASSA_SECRET_KEY}`);
    const paymentResponse = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(eventPaymentId)}`, {
      headers: { 'Authorization': `Basic ${credentials}` }
    });
    if (!paymentResponse.ok) return new Response('Payment verification failed', { status: 502 });

    const confirmedPayment = await paymentResponse.json();
    if (confirmedPayment.status !== 'succeeded') return new Response('Payment not succeeded', { status: 200 });
    const metadata = confirmedPayment.metadata || {};
    const token = metadata.token;
    if (!token) return new Response('Missing order token', { status: 400 });

    const tokenDataRaw = await env.TEST_TOKENS.get(token);
    if (!tokenDataRaw) return new Response('Order token not found', { status: 200 });
    const tokenData = JSON.parse(tokenDataRaw);
    if (metadata.productKey !== tokenData.productKey || (tokenData.paymentId && tokenData.paymentId !== confirmedPayment.id)) {
      return new Response('Order mismatch', { status: 400 });
    }

    // Сейчас все товары намеренно оплачиваются по 1 ₽ в тестовом режиме.
    // Перед включением реальных цен обязательно обновить ожидаемую сумму здесь.
    const expectedAmountByProduct = {
      '7': '1.00', '7_basic': '1.00', '7_advanced': '1.00',
      '8': '1.00', '8_basic': '1.00', '8_advanced': '1.00',
      '9': '1.00', '9_basic': '1.00', '9_advanced': '1.00',
      '10': '1.00', '10_basic': '1.00', '10_advanced': '1.00',
      '11': '1.00', '11_basic': '1.00', '11_advanced': '1.00'
    };
    const expectedAmount = tokenData.expectedPaymentAmount || expectedAmountByProduct[tokenData.productKey];
    const actualAmount = confirmedPayment.amount;
    if (
      !expectedAmount ||
      !actualAmount ||
      actualAmount.currency !== 'RUB' ||
      Number(actualAmount.value).toFixed(2) !== expectedAmount
    ) {
      console.error('Payment amount mismatch:', {
        paymentId: confirmedPayment.id,
        productKey: tokenData.productKey,
        amount: actualAmount
      });
      return new Response('Payment amount mismatch', { status: 400 });
    }

    tokenData.isPaid = true;
    tokenData.paymentId = confirmedPayment.id;
    tokenData.paidAt = confirmedPayment.captured_at || confirmedPayment.created_at || new Date().toISOString();
    tokenData.linkExpiresAt = Date.parse(tokenData.paidAt) + ORDER_ACCESS_TTL_MS;
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
    scheduleOrderSync(context, { env, token, order: tokenData, event: "payment_succeeded" });

    // Отправляем клиенту ссылку на оплаченную диагностику отдельным письмом.
    // Маркер записываем только после успешного ответа Resend: повторный webhook
    // сможет повторить отправку, если первая попытка завершилась ошибкой.
    let diagnosticLinkEmailFailed = false;
    if (!tokenData.diagnosticLinkEmailSentAt && (!tokenData.email || !env.RESEND_API_KEY)) {
      diagnosticLinkEmailFailed = true;
      console.error("Diagnostic link email cannot be sent: missing customer email or RESEND_API_KEY.");
    }
    if (!tokenData.diagnosticLinkEmailSentAt && tokenData.email && env.RESEND_API_KEY) {
      const testFiles = {
        "7": "test_7_basic.html", "7_basic": "test_7_basic.html", "7_advanced": "test_7_advanced.html",
        "8": "test_8_basic.html", "8_basic": "test_8_basic.html", "8_advanced": "test_8_advanced.html",
        "9": "test_9_basic.html", "9_basic": "test_9_basic.html", "9_advanced": "test_9_advanced.html",
        "10": "test_10_basic.html", "10_basic": "test_10_basic.html", "10_advanced": "test_10_advanced.html",
        "11": "test_11_basic.html", "11_basic": "test_11_basic.html", "11_advanced": "test_11_advanced.html"
      };
      const testFile = testFiles[tokenData.productKey];
      if (testFile) {
        const diagnosticUrl = "https://reshai360.ru/" + testFile + "?token=" + encodeURIComponent(token);
        const safeName = String(tokenData.studentName || "Здравствуйте").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        try {
          const emailResponse = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + env.RESEND_API_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "Решай360 <info@reshai360.ru>",
              to: [String(tokenData.email).trim()],
              subject: "Ваша ссылка на диагностику Решай360",
              text: "Здравствуйте, " + (tokenData.studentName || "") + "!\n\nОплата подтверждена. Перейдите по ссылке, чтобы начать диагностику:\n" + diagnosticUrl + "\n\nВажно: ссылка на диагностику действует 7 дней с момента оплаты. Пожалуйста, начните и завершите прохождение в течение этого времени.\n\nС заботой о знаниях и хвостиках,\nКоманда Решай360",
              html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#eef2ff;font-family:Arial,Helvetica,sans-serif;color:#172033;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:linear-gradient(135deg,#eef2ff,#f5f3ff);padding:28px 12px;"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 12px 35px rgba(30,41,59,.12);"><tr><td style="padding:28px 30px;background:linear-gradient(120deg,#312e81,#4f46e5,#0891b2);color:#fff;"><div style="font-size:13px;font-weight:700;letter-spacing:2px;">РЕШАЙ360</div><h1 style="margin:12px 0 0;font-size:25px;line-height:1.25;">Оплата подтверждена!</h1></td></tr><tr><td style="padding:28px 30px;"><p style="margin:0 0 16px;font-size:16px;">Здравствуйте, <strong>${safeName}</strong>!</p><p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#475569;">Спасибо за заказ. Ваша диагностика готова к прохождению. Нажмите на кнопку ниже, чтобы открыть её.</p><p style="margin:0 0 24px;text-align:center;"><a href="${diagnosticUrl}" style="display:inline-block;padding:14px 24px;border-radius:12px;background:linear-gradient(100deg,#4f46e5,#0891b2);color:#fff;text-decoration:none;font-size:15px;font-weight:700;">Перейти к диагностике</a></p><div style="padding:16px 18px;border-radius:14px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;"><p style="margin:0 0 6px;font-size:14px;font-weight:700;">Важно: ссылка на диагностику действует 7 дней.</p><p style="margin:0;font-size:14px;line-height:1.65;">Пожалуйста, начните и завершите прохождение в течение этого времени.</p></div><p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#475569;">С заботой о знаниях и хвостиках,<br><strong>Команда Решай360</strong></p></td></tr><tr><td style="padding:20px 30px;background:#0f172a;color:#cbd5e1;font-size:12px;"><a href="https://reshai360.ru" style="color:#a5b4fc;text-decoration:none;">reshai360.ru</a> · 100 ₽ с каждой оплаченной диагностики направляем в приют «Собачий мир».</td></tr></table></td></tr></table></body></html>`
            })
          });
          if (!emailResponse.ok) {
            diagnosticLinkEmailFailed = true;
            console.error("Diagnostic link email error:", (await emailResponse.text()).slice(0, 700));
          } else {
            const emailResult = await emailResponse.json().catch(() => ({}));
            tokenData.diagnosticLinkEmailSentAt = new Date().toISOString();
            tokenData.diagnosticLinkEmailId = emailResult.id || null;
            await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
          }
        } catch (emailError) {
          diagnosticLinkEmailFailed = true;
          console.error("Diagnostic link email error:", emailError);
        }
      } else {
        console.error("Diagnostic link email skipped: unknown product key", tokenData.productKey);
      }
    }

    // Партнёрское начисление создаётся только после серверного подтверждения оплаты.
    // Ключ основан на payment ID: повторный webhook перезаписывает ту же запись, а не создаёт новую.
    // По умолчанию партнёрские начисления выключены: сейчас платежи проекта в тестовом режиме по 1 ₽.
    // Включать PARTNER_PROGRAM_ENABLED=true только после переключения оплаты на реальные цены.
    if (env.PARTNER_PROGRAM_ENABLED === 'true' && tokenData.referralCode && /^[a-z0-9_-]{3,32}$/.test(tokenData.referralCode)) {
      const partnerCode = tokenData.referralCode;
      const partnerRaw = await env.TEST_TOKENS.get('partner:profile:' + partnerCode);
      if (partnerRaw) {
        const partner = JSON.parse(partnerRaw);
        if (partner.active !== false) {
          const commissionKey = 'partner:commission:' + String(confirmedPayment.id);
          const existingCommissionRaw = await env.TEST_TOKENS.get(commissionKey);
          if (!existingCommissionRaw) {
            await env.TEST_TOKENS.put(commissionKey, JSON.stringify({
              paymentId: String(confirmedPayment.id),
              orderToken: token,
              partnerCode,
              productKey: tokenData.productKey,
              amount: 100,
              currency: 'RUB',
              paidAt: tokenData.paidAt,
              status: 'accrued',
              createdAt: new Date().toISOString()
            }));
          }
        }
      }
    }

    // Промокод считается использованным только после подтверждённой оплаты.
    if (tokenData.promoCode) {
      const promoKey = 'promo:' + String(tokenData.promoCode).toUpperCase();
      const promoRaw = await env.TEST_TOKENS.get(promoKey);
      if (promoRaw) {
        const promo = JSON.parse(promoRaw);
        if (promo.reservedBy === token && !promo.used) {
          promo.used = true;
          promo.usedAt = Date.now();
          promo.usedByEmail = tokenData.email || null;
          promo.reservedBy = null;
          promo.reservedUntil = null;
          await env.TEST_TOKENS.put(promoKey, JSON.stringify(promo), { expirationTtl: 15552000 });
        }
      }
    }
    // Telegram-уведомление обязательно подтверждаем ответом Bot API.
    const telegramResult = await sendPaymentTelegramNotification({
      env,
      token,
      tokenData,
      amount: actualAmount.value
    });
    if (!telegramResult.sent || diagnosticLinkEmailFailed) {
      return new Response(
        !telegramResult.sent ? (telegramResult.configured ? 'Telegram notification failed' : 'Telegram notification is not configured') : 'Diagnostic link email failed',
        { status: 503 }
      );
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Payment webhook error:', err);
    return new Response('Error', { status: 500 });
  }
}

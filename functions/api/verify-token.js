import { sendPaymentTelegramNotification, ensurePaidOrderLinkExpiry, getOrderExpirationTtl, ORDER_ACCESS_TTL_MS } from "../_lib/telegram-payment.js";
import { sendDiagnosticLinkEmail } from "../_lib/diagnostic-link-email.js";
import { scheduleOrderSync } from "../_lib/google-sheets.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { token } = await request.json();
    if (!token || typeof token !== 'string') {
      return Response.json({ valid: false, message: 'Токен не найден.' }, { status: 400 });
    }

    const tokenDataRaw = await env.TEST_TOKENS.get(token);
    if (!tokenDataRaw) {
      return Response.json({ valid: false, message: 'Ссылка недействительна или истек срок её действия.' });
    }

    const tokenData = JSON.parse(tokenDataRaw);
    let orderDataChanged = false;
    if (tokenData.isPaid === true) {
      const oldExpiry = Number(tokenData.linkExpiresAt) || null;
      const expiresAt = ensurePaidOrderLinkExpiry(tokenData);
      if (expiresAt <= Date.now()) return Response.json({ valid: false, message: "Срок действия ссылки на диагностику истёк." }, { status: 403 });
      if (Number(tokenData.linkExpiresAt) !== oldExpiry) orderDataChanged = true;
    }

    // Черновик прогресса хранится отдельно от заказа, чтобы автосохранение
    // не продлевало срок действия оплаченной ссылки.
    let progressSnapshot = null;
    const progressRaw = await env.TEST_TOKENS.get("progress:" + token);
    if (progressRaw) {
      try { progressSnapshot = JSON.parse(progressRaw); } catch (_) {}
    }

    // Если webhook ещё не успел обработать событие, проверяем платёж напрямую
    // через API ЮKassa по сохранённому paymentId.
    if (tokenData.isPaid !== true && tokenData.paymentId && env.YOKASSA_SHOP_ID && env.YOKASSA_SECRET_KEY) {
      try {
        const credentials = btoa(`${env.YOKASSA_SHOP_ID}:${env.YOKASSA_SECRET_KEY}`);
        const paymentResponse = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(tokenData.paymentId)}`, {
          headers: { 'Authorization': `Basic ${credentials}` }
        });

        if (paymentResponse.ok) {
          const payment = await paymentResponse.json();
          const expectedAmountByProduct = {
            '7': '1.00', '7_basic': '1.00', '7_advanced': '1.00',
            '8': '1.00', '8_basic': '1.00', '8_advanced': '1.00',
            '9': '1.00', '9_basic': '1.00', '9_advanced': '1.00',
            '10': '1.00', '10_basic': '1.00', '10_advanced': '1.00',
            '11': '1.00', '11_basic': '1.00', '11_advanced': '1.00'
          };
          const expectedAmount = tokenData.expectedPaymentAmount || expectedAmountByProduct[tokenData.productKey];
          const actualAmount = payment.amount;
          const metadata = payment.metadata || {};
          const paymentMatchesOrder =
            payment.id === tokenData.paymentId &&
            metadata.token === token &&
            metadata.productKey === tokenData.productKey &&
            expectedAmount &&
            actualAmount &&
            actualAmount.currency === 'RUB' &&
            Number(actualAmount.value).toFixed(2) === expectedAmount;

          if (payment.status === 'succeeded' && paymentMatchesOrder) {
            tokenData.isPaid = true;
            tokenData.paymentId = payment.id;
            tokenData.paidAt = payment.captured_at || payment.created_at || new Date().toISOString();
            tokenData.linkExpiresAt = Date.parse(tokenData.paidAt) + ORDER_ACCESS_TTL_MS;
            tokenData.paymentCanceled = false;
            orderDataChanged = true;
            await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
          } else if (payment.status === 'canceled' && paymentMatchesOrder) {
            tokenData.paymentCanceled = true;
            orderDataChanged = true;
            await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });
          }
        }
      } catch (paymentCheckError) {
        // Временная недоступность API не превращает заказ в неоплаченный:
        // ниже вернём статус ожидания, а клиент сможет повторить проверку.
        console.error('Direct YooKassa payment check failed:', paymentCheckError);
      }
    }

    if (tokenData.isPaid !== true) {
      if (tokenData.paymentCanceled === true) {
        return Response.json({ valid: false, message: 'Платёж отменён банком. Можно безопасно попробовать оплатить ещё раз.' }, { status: 409 });
      }
      return Response.json({ valid: false, message: 'Платёж ещё подтверждается.' }, { status: 402 });
    }

    // Если webhook не сработал или письмо не удалось отправить раньше,
    // повторяем отправку ссылки. Ошибка почты не блокирует доступ к оплаченной диагностике.
    const diagnosticEmailResult = await sendDiagnosticLinkEmail({ env, token, tokenData });
    if (!diagnosticEmailResult.sent) {
      console.error("Payment was verified, but diagnostic link email is pending a retry.");
    }

    // Если оплату подтвердили резервной проверкой или webhook ещё не успел отправить уведомление,
    // повторяем отправку здесь. Маркер в KV защищает от повторных сообщений.
    if (!tokenData.paymentTelegramSentAt) {
      const telegramResult = await sendPaymentTelegramNotification({
        env,
        token,
        tokenData,
        amount: tokenData.expectedPaymentAmount
      });
      // Отсутствие Telegram-конфигурации не должно блокировать доступ к уже оплаченному тесту.
      if (!telegramResult.sent && telegramResult.configured) {
        console.error("Payment was verified, but Telegram notification is pending a retry.");
      }
    }

    // Синхронизируем одноразовый промокод и при прямой проверке оплаты,
    // даже если webhook ЮKassa задержался или не был доставлен.
    if (tokenData.promoCode && env.TEST_TOKENS) {
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

    // Завершённый заказ можно открыть повторно: клиент восстановит сохранённые ответы
    // и покажет результат, не начиная новую диагностику.
    if (!tokenData.isCompleted) { tokenData.isUsed = true; orderDataChanged = true; }
    if (orderDataChanged) await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });

    // Повторно синхронизируем подтверждённый заказ при каждом успешном открытии:
    // это восстанавливает строку таблицы, если webhook не дошёл или его sync завершился ошибкой.
    scheduleOrderSync(context, { env, token, order: tokenData, event: "payment_verified" });

    return Response.json({ valid: true, data: { ...tokenData, progressSnapshot }, completed: tokenData.isCompleted === true });
  } catch (err) {
    console.error('Verify token error:', err);
    return Response.json({ valid: false, message: 'Ошибка проверки оплаты.' }, { status: 500 });
  }
}

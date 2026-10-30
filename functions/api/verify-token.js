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
            await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
          }
        }
      } catch (paymentCheckError) {
        // Временная недоступность API не превращает заказ в неоплаченный:
        // ниже вернём статус ожидания, а клиент сможет повторить проверку.
        console.error('Direct YooKassa payment check failed:', paymentCheckError);
      }
    }

    if (tokenData.isPaid !== true) {
      return Response.json({ valid: false, message: 'Платёж ещё подтверждается.' }, { status: 402 });
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
    if (!tokenData.isCompleted) {
      tokenData.isUsed = true;
      await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
    }
    return Response.json({ valid: true, data: tokenData, completed: tokenData.isCompleted === true });
  } catch (err) {
    console.error('Verify token error:', err);
    return Response.json({ valid: false, message: 'Ошибка проверки оплаты.' }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const event = await request.json();
    if (event.event !== 'payment.succeeded') return new Response('OK', { status: 200 });

    // Не доверяем телу входящего webhook: сверяем платёж напрямую с API ЮKassa.
    const eventPaymentId = event.object && event.object.id;
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
    if (metadata.productKey !== tokenData.productKey) return new Response('Order mismatch', { status: 400 });

    // Сейчас все товары намеренно оплачиваются по 1 ₽ в тестовом режиме.
    // Перед включением реальных цен обязательно обновить ожидаемую сумму здесь.
    const expectedAmountByProduct = {
      '7': '1.00', '7_basic': '1.00', '7_advanced': '1.00',
      '8': '1.00', '8_basic': '1.00', '8_advanced': '1.00',
      '9': '1.00', '9_basic': '1.00', '9_advanced': '1.00',
      '10': '1.00', '10_basic': '1.00', '10_advanced': '1.00',
      '11': '1.00', '11_basic': '1.00', '11_advanced': '1.00'
    };
    const expectedAmount = expectedAmountByProduct[tokenData.productKey];
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
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });

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
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Payment webhook error:', err);
    return new Response('Error', { status: 500 });
  }
}

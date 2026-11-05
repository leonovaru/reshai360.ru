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
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });

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
    // Уведомление об оплате отправляется отдельным ботом; при ошибке webhook можно безопасно повторить.
    if (env.TELEGRAM_PAYMENT_BOT_TOKEN && env.TG_CHAT_ID && !tokenData.paymentTelegramSentAt) {
      const testFiles = {
        '7': 'test_7_basic.html', '7_basic': 'test_7_basic.html', '7_advanced': 'test_7_advanced.html',
        '8': 'test_8_basic.html', '8_basic': 'test_8_basic.html', '8_advanced': 'test_8_advanced.html',
        '9': 'test_9_basic.html', '9_basic': 'test_9_basic.html', '9_advanced': 'test_9_advanced.html',
        '10': 'test_10_basic.html', '10_basic': 'test_10_basic.html', '10_advanced': 'test_10_advanced.html',
        '11': 'test_11_basic.html', '11_basic': 'test_11_basic.html', '11_advanced': 'test_11_advanced.html'
      };
      const testUrl = 'https://reshai360.ru/' + (testFiles[tokenData.productKey] || 'index.html') + '?token=' + encodeURIComponent(token);
      const money = value => Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
      const lines = [
        '💳 ОПЛАТА ПОДТВЕРЖДЕНА — РЕШАЙ360',
        'Имя: ' + (tokenData.studentName || 'Не указано'),
        'Email: ' + (tokenData.email || 'Не указан'),
        'Диагностика: ' + (tokenData.productTitle || tokenData.productKey || 'Не указана'),
        'Стоимость: ' + money(tokenData.displayAmount ?? tokenData.listPrice ?? actualAmount.value),
        tokenData.promoCode ? 'Введённый промокод: ' + tokenData.promoCode : 'Промокод: не вводили',
        tokenData.promoCode ? 'Скидка: ' + money(tokenData.discountAmount) + ' (' + Number(tokenData.discountPercent || 0).toLocaleString('ru-RU') + '%)' : '',
        'Ссылка на диагностику: ' + testUrl
      ].filter(Boolean);
      try {
        const tgResponse = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_PAYMENT_BOT_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: lines.join('\\n'), disable_web_page_preview: true })
        });
        if (!tgResponse.ok) {
          console.error('Telegram payment notification error:', await tgResponse.text());
          return new Response('Telegram notification failed', { status: 500 });
        }
        tokenData.paymentTelegramSentAt = new Date().toISOString();
        await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
      } catch (telegramError) {
        console.error('Telegram payment notification error:', telegramError);
        return new Response('Telegram notification failed', { status: 500 });
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Payment webhook error:', err);
    return new Response('Error', { status: 500 });
  }
}

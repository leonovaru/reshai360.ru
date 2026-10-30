export async function onRequestPost(context) {
  const { request, env } = context;
  let createdToken = null;
  let reservedPromoCode = null;
  let paymentRequestStarted = false;

  // Освобождаем резерв промокода и удаляем незавершённый заказ при ошибке создания платежа.
  async function rollbackPendingOrder() {
    if (createdToken && env.TEST_TOKENS) {
      try { await env.TEST_TOKENS.delete(createdToken); } catch (error) {
        console.error('Не удалось удалить незавершённый заказ:', error);
      }
    }
    if (reservedPromoCode && createdToken && env.TEST_TOKENS) {
      try {
        const key = 'promo:' + reservedPromoCode;
        const raw = await env.TEST_TOKENS.get(key);
        if (raw) {
          const promo = JSON.parse(raw);
          if (promo.reservedBy === createdToken && !promo.used) {
            promo.reservedBy = null;
            promo.reservedUntil = null;
            await env.TEST_TOKENS.put(key, JSON.stringify(promo), { expirationTtl: 15552000 });
          }
        }
      } catch (error) {
        console.error('Не удалось освободить промокод:', error);
      }
    }
  }

  try {
    const { studentName, email, productKey, promoCode: rawPromoCode, referralCode: rawReferralCode, personalDataConsent, offerAccepted } = await request.json();
    if (personalDataConsent !== true || offerAccepted !== true) {
      return Response.json({ message: "Для оформления заказа необходимо отдельно подтвердить согласие на обработку персональных данных и принятие публичной оферты." }, { status: 400 });
    }
    const consentAt = new Date().toISOString();
    const consentRecord = {
      studentName: String(studentName || "").trim(),
      email: String(email || "").trim().toLowerCase(),
      personalDataConsent: true,
      personalDataConsentAt: consentAt,
      personalDataConsentVersion: "2026-10-30",
      offerAccepted: true,
      offerAcceptedAt: consentAt,
      offerVersion: "2026-10-30"
    };
    const promoCode = String(rawPromoCode || "").trim().toUpperCase();
    const referralCandidate = String(rawReferralCode || "").trim().toLowerCase();
    let referralCode = null;
    if (/^[a-z0-9_-]{3,32}$/.test(referralCandidate) && env.TEST_TOKENS) {
      // Источник принимается только для существующего партнёра из серверного реестра.
      const partnerRaw = await env.TEST_TOKENS.get('partner:profile:' + referralCandidate);
      if (partnerRaw) {
        const partner = JSON.parse(partnerRaw);
        if (partner.active !== false) referralCode = referralCandidate;
      }
    }

    const PRODUCTS = {
      '7': { title: 'Диагностика — 7 класс (старый заказ)', price: 1, displayPrice: 790, file: 'test_7_basic.html' },
      '7_basic': { title: 'Диагностика — 7 класс, базовый уровень', price: 1, displayPrice: 790, file: 'test_7_basic.html' },
      '7_advanced': { title: 'Диагностика — 7 класс, продвинутый уровень', price: 1, displayPrice: 990, file: 'test_7_advanced.html' },
      '8': { title: 'Диагностика — 8 класс (старый заказ)', price: 1, displayPrice: 790, file: 'test_8_basic.html' },
      '8_basic': { title: 'Диагностика — 8 класс, базовый уровень', price: 1, displayPrice: 790, file: 'test_8_basic.html' },
      '8_advanced': { title: 'Диагностика — 8 класс, продвинутый уровень', price: 1, displayPrice: 990, file: 'test_8_advanced.html' },
      '9': { title: 'Диагностика — 9 класс (старый заказ)', price: 1, displayPrice: 790, file: 'test_9_basic.html' },
      '9_basic': { title: 'Диагностика — 9 класс, базовый уровень', price: 1, displayPrice: 790, file: 'test_9_basic.html' },
      '9_advanced': { title: 'Диагностика — 9 класс, продвинутый уровень', price: 1, displayPrice: 990, file: 'test_9_advanced.html' },
      '10': { title: 'Диагностика — 10 класс (старый заказ)', price: 1, displayPrice: 790, file: 'test_10_basic.html' },
      '11': { title: 'Диагностика — 11 класс (старый заказ)', price: 1, displayPrice: 790, file: 'test_11_basic.html' },
      '10_basic': { title: 'Диагностика — 10 класс, базовый уровень', price: 1, displayPrice: 790, file: 'test_10_basic.html' },
      '10_advanced': { title: 'Диагностика — 10 класс, продвинутый уровень', price: 1, displayPrice: 990, file: 'test_10_advanced.html' },
      '11_basic': { title: 'Диагностика — 11 класс, базовый уровень', price: 1, file: 'test_11_basic.html' },
      '11_advanced': { title: 'Диагностика — 11 класс, продвинутый уровень', price: 1, displayPrice: 990, file: 'test_11_advanced.html' }
    };
    PRODUCTS['11_basic'].displayPrice = 790;

    const product = PRODUCTS[productKey];
    if (!product) {
      return new Response(JSON.stringify({ message: 'Выбран неизвестный класс' }), { status: 400 });
    }
    const testMode = env.PAYMENT_TEST_MODE !== 'false';
    const discountPercent = promoRecord ? Math.max(0, Math.min(100, Number(promoRecord.discountPercent) || 0)) : 0;
    const discountedDisplayPrice = Math.max(1, Math.round(product.displayPrice * (100 - discountPercent) / 100));
    const paymentAmount = testMode ? 1 : discountedDisplayPrice;
    const expectedPaymentAmount = paymentAmount.toFixed(2);

    // Проверяем промокод на сервере. Сам код хранится в KV, а не в браузере.
    let promoRecord = null;
    if (promoCode) {
      if (!env.TEST_TOKENS) {
        return new Response(JSON.stringify({ message: 'Хранилище промокодов не настроено.' }), { status: 503 });
      }
      const promoRaw = await env.TEST_TOKENS.get('promo:' + promoCode);
      if (!promoRaw) return new Response(JSON.stringify({ message: 'Промокод не найден или срок его действия истёк.' }), { status: 400 });
      promoRecord = JSON.parse(promoRaw);
      if (promoRecord.expiresAt && promoRecord.expiresAt <= Date.now()) return new Response(JSON.stringify({ message: 'Срок действия промокода закончился.' }), { status: 410 });
      if (promoRecord.used) return new Response(JSON.stringify({ message: 'Промокод уже использован.' }), { status: 409 });
      if (promoRecord.reservedUntil && promoRecord.reservedUntil > Date.now()) {
        return new Response(JSON.stringify({ message: 'Промокод уже оформляется в другом заказе. Попробуйте позже.' }), { status: 409 });
      }
      if (!product.displayPrice) return new Response(JSON.stringify({ message: 'Промокод доступен только для поддерживаемых диагностик.' }), { status: 400 });
    }

    // Генерируем уникальный защищенный токен
    const token = crypto.randomUUID() + '-' + crypto.randomUUID();
    createdToken = token;
    if (promoCode) reservedPromoCode = promoCode;

    // Сохраняем заказ в KV-хранилище (срок жизни 24 часа)
    await env.TEST_TOKENS.put(token, JSON.stringify({
      studentName,
      email,
      productKey,
      promoCode: promoCode || null,
      referralCode,
      consentRecord,
      isPaid: false,
      isUsed: false,
      expectedPaymentAmount,
      paymentTestMode: testMode,
      discountPercent,
      displayAmount: discountedDisplayPrice
    }), { expirationTtl: 86400 });
    // Отдельная запись подтверждения согласия нужна для доказуемости факта и версии документов.
    await env.TEST_TOKENS.put("consent:" + token, JSON.stringify({
      ...consentRecord,
      orderToken: token,
      recordedAt: consentAt
    }), { expirationTtl: 94608000 });

    // Короткая резервация не даёт параллельно применить один промокод в нескольких заказах.
    if (promoCode && promoRecord) {
      promoRecord.reservedBy = token;
      promoRecord.reservedUntil = Date.now() + 30 * 60 * 1000;
      await env.TEST_TOKENS.put('promo:' + promoCode, JSON.stringify(promoRecord), { expirationTtl: 15552000 });
    }

    const credentials = btoa(`${env.YOKASSA_SHOP_ID}:${env.YOKASSA_SECRET_KEY}`);
    const idempotenceKey = crypto.randomUUID();

    // С этого момента сетевой сбой не доказывает, что платёж не создан.
    paymentRequestStarted = true;
    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Idempotence-Key': idempotenceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: { value: expectedPaymentAmount, currency: 'RUB' },
        confirmation: { type: 'embedded' },
        capture: true,
        description: `${product.title} (${email})`,
        metadata: { studentName, email, productKey, token },
        receipt: {
          customer: { email: email },
          items: [{
            description: product.title,
            quantity: '1.00',
            amount: { value: expectedPaymentAmount, currency: 'RUB' },
            vat_code: '1'
          }]
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Ошибка ЮKassa API:', response.status, errorText);
      // 4xx означает отказ запроса; 5xx может быть неоднозначным, поэтому заказ сохраняем.
      if (response.status >= 400 && response.status < 500) await rollbackPendingOrder();
      return new Response(JSON.stringify({ message: 'Ошибка платежной системы. Попробуйте позже.' }), { status: 502 });
    }

    const payment = await response.json();
    if (!payment.confirmation || !payment.confirmation.confirmation_token || !payment.id) {
      throw new Error('Некорректный ответ от платежного шлюза');
    }

    // Сохраняем ID платежа в заказе. Тогда success-страница сможет сама
    // запросить актуальный статус у ЮKassa, не ожидая webhook.
    const latestTokenRaw = await env.TEST_TOKENS.get(createdToken);
    if (latestTokenRaw) {
      const latestTokenData = JSON.parse(latestTokenRaw);
      latestTokenData.paymentId = payment.id;
      await env.TEST_TOKENS.put(createdToken, JSON.stringify(latestTokenData), { expirationTtl: 86400 });
    }

    return new Response(JSON.stringify({
      confirmationToken: payment.confirmation.confirmation_token,
      returnUrl: `https://reshai360.ru/success.html?token=${encodeURIComponent(createdToken)}&productKey=${encodeURIComponent(productKey)}`
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Create payment error:', error);
    // Если запрос в ЮKassa уже отправлен, оставляем заказ для возможного webhook.
    if (!paymentRequestStarted) await rollbackPendingOrder();
    return new Response(JSON.stringify({ message: 'Не удалось получить подтверждение от платёжной системы. Если платёж прошёл, обратитесь в поддержку.' }), { status: 500 });
  }
}

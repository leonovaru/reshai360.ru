export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const { studentName, email, productKey, promoCode: rawPromoCode } = await request.json();
    const promoCode = String(rawPromoCode || "").trim().toUpperCase();

    const PRODUCTS = {
      '7': { title: 'Диагностика — 7 класс', price: 1, file: 'test_7.html' },
      '8': { title: 'Диагностика — 8 класс', price: 1, file: 'test_8.html' },
      '8_basic': { title: 'Диагностика — 8 класс, базовый уровень', price: 1, displayPrice: 790, file: 'test_8_basic.html' },
      '8_advanced': { title: 'Диагностика — 8 класс, продвинутый уровень', price: 1, displayPrice: 990, file: 'test_8_advanced.html' },
      '9': { title: 'Диагностика — 9 класс (ОГЭ, старый заказ)', price: 1, file: 'test_9.html' },
      '9_basic': { title: 'Диагностика — 9 класс, базовый уровень', price: 1, displayPrice: 790, file: 'test_9_basic.html' },
      '9_advanced': { title: 'Диагностика — 9 класс, продвинутый уровень', price: 1, displayPrice: 990, file: 'test_9_advanced.html' },
      '10': { title: 'Диагностика — 10 класс', price: 1, file: 'test_10.html' },
      '11': { title: 'Диагностика — 11 класс (старый заказ)', price: 1, file: 'test_11.html' },
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

    // Сохраняем заказ в KV-хранилище (срок жизни 24 часа)
    await env.TEST_TOKENS.put(token, JSON.stringify({
      studentName,
      email,
      productKey,
      promoCode: promoCode || null,
      isPaid: false,
      isUsed: false
    }), { expirationTtl: 86400 });

    // Короткая резервация не даёт параллельно применить один промокод в нескольких заказах.
    if (promoCode && promoRecord) {
      promoRecord.reservedBy = token;
      promoRecord.reservedUntil = Date.now() + 30 * 60 * 1000;
      await env.TEST_TOKENS.put('promo:' + promoCode, JSON.stringify(promoRecord), { expirationTtl: 15552000 });
    }

    const credentials = btoa(`${env.YOKASSA_SHOP_ID}:${env.YOKASSA_SECRET_KEY}`);
    const idempotenceKey = crypto.randomUUID();

    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Idempotence-Key': idempotenceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: { value: `${product.price}.00`, currency: 'RUB' },
        confirmation: {
          type: 'redirect',
          return_url: `https://reshai360.ru/success.html?token=${token}&productKey=${productKey}`
        },
        capture: true,
        description: `${product.title} (${email})`,
        metadata: { studentName, email, productKey, token },
        receipt: {
          customer: { email: email },
          items: [{
            description: product.title,
            quantity: '1.00',
            amount: { value: `${product.price}.00`, currency: 'RUB' },
            vat_code: '1'
          }]
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Ошибка ЮKassa API:', response.status, errorText);
      return new Response(JSON.stringify({ message: 'Ошибка платежной системы. Попробуйте позже.' }), { status: 502 });
    }

    const payment = await response.json();
    if (!payment.confirmation || !payment.confirmation.confirmation_url) {
      throw new Error('Некорректный ответ от платежного шлюза');
    }

    return new Response(JSON.stringify({ confirmationUrl: payment.confirmation.confirmation_url }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Create payment error:', error);
    return new Response(JSON.stringify({ message: 'Внутренняя ошибка сервера' }), { status: 500 });
  }
}

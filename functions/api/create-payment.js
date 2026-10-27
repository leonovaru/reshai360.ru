export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const { studentName, email, productKey } = await request.json();

    const PRODUCTS = {
      '7': { title: 'Диагностика — 7 класс', price: 1, file: 'test_7.html' },
      '8': { title: 'Диагностика — 8 класс', price: 1, file: 'test_8.html' },
      '9': { title: 'Диагностика — 9 класс (ОГЭ)', price: 1, file: 'test_9.html' },
      '10': { title: 'Диагностика — 10 класс', price: 1, file: 'test_10.html' },
      '11': { title: 'Диагностика — 11 класс', price: 1, file: 'test_11.html' }
    };

    const product = PRODUCTS[productKey];
    if (!product) {
      return new Response(JSON.stringify({ message: 'Выбран неизвестный класс' }), { status: 400 });
    }

    // Генерируем уникальный защищенный токен
    const token = crypto.randomUUID() + '-' + crypto.randomUUID();

    // Сохраняем в KV-хранилище (срок жизни 24 часа)
    await env.TEST_TOKENS.put(token, JSON.stringify({
      studentName,
      email,
      productKey,
      isPaid: false,
      isUsed: false
    }), { expirationTtl: 86400 });

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

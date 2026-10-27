export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const { studentName, email, productKey } = await request.json();

    // Доверенная база продуктов и цен на сервере
    const PRODUCTS = {
      'class_9': { title: 'Диагностика — 9 класс (ОГЭ)', price: 990, file: 'test-9-class.html' },
      'class_10': { title: 'Диагностика — 10 класс', price: 1190, file: 'test-10-class.html' },
      'class_11_base': { title: 'Диагностика — 11 класс (ЕГЭ База)', price: 1390, file: 'test-11-base.html' },
      'class_11_prof': { title: 'Диагностика — 11 класс (ЕГЭ Профиль)', price: 1490, file: 'test-11-prof.html' }
    };

    const product = PRODUCTS[productKey];
    if (!product) {
      return new Response(JSON.stringify({ message: 'Выбран неизвестный класс' }), { status: 400 });
    }

    // Авторизация в ЮKassa через скрытые переменные окружения
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
          return_url: `https://reshai360.ru/${product.file}`
        },
        capture: true,
        description: `${product.title} (${email})`,
        metadata: { studentName, email, productKey },
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

    const payment = await response.json();
    if (!payment.confirmation) throw new Error('Ошибка связи с ЮKassa');

    return new Response(JSON.stringify({ confirmationUrl: payment.confirmation.confirmation_url }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ message: error.message }), { status: 500 });
  }
}

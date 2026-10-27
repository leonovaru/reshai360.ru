export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const event = await request.json();

    // Обрабатываем событие успешного платежа от ЮKassa
    if (event.event === 'payment.succeeded') {
      const payment = event.object;
      const metadata = payment.metadata || {};

      // Извлекаем токен, который был предварительно создан при инициализации платежа, 
      // либо генерируем новый, если он не был передан в метаданных
      const token = metadata.token || (crypto.randomUUID() + '-' + crypto.randomUUID());

      // Сохраняем надежные данные в защищенное KV-хранилище (срок жизни 24 часа)
      await env.TEST_TOKENS.put(token, JSON.stringify({
        studentName: metadata.studentName || 'Ученик',
        email: metadata.email || '',
        productKey: metadata.productKey || '11',
        isUsed: false,
        paid: true
      }), { expirationTtl: 86400 });
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return new Response('Error', { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const event = await request.json();

    if (event.event === 'payment.succeeded') {
      const payment = event.object;
      const metadata = payment.metadata;

      // Генерируем уникальный защищенный токен
      const token = crypto.randomUUID() + '-' + crypto.randomUUID();

      // Сохраняем в KV-хранилище (срок жизни 24 часа, если не открыли тест)
      await env.TEST_TOKENS.put(token, JSON.stringify({
        studentName: metadata.studentName,
        email: metadata.email,
        productKey: metadata.productKey,
        isUsed: false
      }), { expirationTtl: 86400 });
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    return new Response('Error', { status: 500 });
  }
}

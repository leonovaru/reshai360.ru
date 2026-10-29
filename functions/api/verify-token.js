export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { token } = await request.json();
    const tokenDataRaw = await env.TEST_TOKENS.get(token);

    if (!tokenDataRaw) {
      return new Response(JSON.stringify({ valid: false, message: 'Ссылка недействительна или истек срок её действия.' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const tokenData = JSON.parse(tokenDataRaw);

    // Доступ выдаётся только после подтверждения платежа webhook-ом.
    if (tokenData.isPaid !== true) {
      return new Response(JSON.stringify({ valid: false, message: 'Оплата ещё не подтверждена. Подождите несколько секунд и обновите страницу.' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // СЕРВЕРНАЯ ЗАЩИТА: если тест уже решен по этой ссылке (в любом браузере), блокируем вход навсегда
    if (tokenData.isCompleted) {
      return new Response(JSON.stringify({ valid: false, message: 'Тест по этой ссылке уже был решен. Повторный доступ с других устройств или браузеров запрещен.' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Помечаем токен как использованный
    tokenData.isUsed = true;
    // Сохраняем исходный срок жизни заказа: обновление записи без TTL могло бы
    // превратить временный токен в бессрочный.
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });

    return new Response(JSON.stringify({ valid: true, data: tokenData }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, message: 'Ошибка проверки' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

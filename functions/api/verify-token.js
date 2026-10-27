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

    // Защита от пересылки: если токен уже использовался, блокируем доступ
    if (tokenData.isUsed) {
      return new Response(JSON.stringify({ valid: false, message: 'Эта ссылка уже была использована. Пересылка запрещена.' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Помечаем токен как использованный
    tokenData.isUsed = true;
    await env.TEST_TOKENS.put(token, JSON.stringify(tokenData));

    return new Response(JSON.stringify({ valid: true, data: tokenData }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, message: 'Ошибка проверки' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

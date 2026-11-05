export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    const headers = { "Cache-Control": "no-store, no-cache, must-revalidate" };

    if (!token) return Response.json({ success: false, message: "Токен не найден." }, { status: 400, headers });
    if (!env.TEST_TOKENS) return Response.json({ success: false, message: "Хранилище прогресса не настроено." }, { status: 503, headers });

    const tokenDataRaw = await env.TEST_TOKENS.get(token);
    if (!tokenDataRaw) return Response.json({ success: false, message: "Ссылка недействительна или срок её действия истёк." }, { status: 403, headers });

    const tokenData = JSON.parse(tokenDataRaw);
    if (tokenData.isPaid !== true) return Response.json({ success: false, message: "Доступ к прогрессу не подтверждён." }, { status: 403, headers });

    const progressRaw = await env.TEST_TOKENS.get("progress:" + token);
    let snapshot = null;
    if (progressRaw) {
      try { snapshot = JSON.parse(progressRaw); } catch (_) {}
    }

    return Response.json({ success: true, snapshot }, { headers });
  } catch (error) {
    console.error("Get diagnostic progress error:", error);
    return Response.json({ success: false, message: "Не удалось получить прогресс." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

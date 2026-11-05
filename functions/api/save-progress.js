export async function onRequestPost({ request, env }) {
  try {
    if (!env.TEST_TOKENS) {
      return Response.json({ success: false, message: "Хранилище прогресса не настроено." }, { status: 503 });
    }

    const body = await request.json();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const input = body.snapshot;

    if (!token || !input || typeof input !== "object" || Array.isArray(input)) {
      return Response.json({ success: false, message: "Некорректные данные прогресса." }, { status: 400 });
    }

    const snapshot = {
      version: 1,
      answers: input.answers && typeof input.answers === "object" && !Array.isArray(input.answers) ? input.answers : {},
      marked: Array.isArray(input.marked) ? input.marked : [],
      stats: input.stats && typeof input.stats === "object" && !Array.isArray(input.stats) ? input.stats : {},
      savedAt: Number.isFinite(Number(input.savedAt)) ? Number(input.savedAt) : Date.now()
    };

    if (JSON.stringify(snapshot).length > 512000) {
      return Response.json({ success: false, message: "Размер прогресса превышает допустимый." }, { status: 413 });
    }

    const tokenDataRaw = await env.TEST_TOKENS.get(token);
    if (!tokenDataRaw) {
      return Response.json({ success: false, message: "Ссылка недействительна или срок её действия истёк." }, { status: 403 });
    }

    const tokenData = JSON.parse(tokenDataRaw);
    if (tokenData.isPaid !== true) {
      return Response.json({ success: false, message: "Прогресс можно сохранить только для оплаченной диагностики." }, { status: 403 });
    }
    if (tokenData.isCompleted === true) {
      return Response.json({ success: false, completed: true, message: "Диагностика уже завершена." }, { status: 409 });
    }

    const previousSavedAt = Number(tokenData.progressSnapshot && tokenData.progressSnapshot.savedAt) || 0;
    if (snapshot.savedAt >= previousSavedAt) {
      tokenData.progressSnapshot = snapshot;
      await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("Save diagnostic progress error:", error);
    return Response.json({ success: false, message: "Не удалось сохранить прогресс." }, { status: 500 });
  }
}

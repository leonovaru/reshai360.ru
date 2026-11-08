const RESULTS_REPORT_VERSION = 8;

export async function onRequestPost({ request, env }) {
  try {
    if (!env.TEST_TOKENS || !env.TELEGRAM_RESULTS_BOT_TOKEN) {
      return Response.json({ success: false, message: "Сохранённый отчёт пока недоступен." }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      return Response.json({ success: false, message: "Не указан токен диагностики." }, { status: 400 });
    }

    const raw = await env.TEST_TOKENS.get(token);
    if (!raw) {
      return Response.json({ success: false, message: "Заказ не найден или срок доступа истёк." }, { status: 404 });
    }

    const order = JSON.parse(raw);
    const expiresAt = Number(order.linkExpiresAt) || 0;
    if (order.isPaid !== true || order.isCompleted !== true || (expiresAt && expiresAt <= Date.now())) {
      return Response.json({ success: false, message: "Доступ к отчёту недействителен." }, { status: 403 });
    }

    const fileId = String(order.resultsTelegramFileId || "").trim();
    if (!fileId || Number(order.resultsTelegramReportVersion || 0) !== RESULTS_REPORT_VERSION) {
      return Response.json({ success: false, message: "Актуальный сохранённый отчёт ещё не готов." }, { status: 404 });
    }

    const botToken = env.TELEGRAM_RESULTS_BOT_TOKEN;
    const fileInfoResponse = await fetch("https://api.telegram.org/bot" + botToken + "/getFile?file_id=" + encodeURIComponent(fileId));
    const fileInfo = await fileInfoResponse.json().catch(() => ({}));
    if (!fileInfoResponse.ok || fileInfo.ok !== true || !fileInfo.result?.file_path) {
      console.error("Telegram getFile error:", JSON.stringify(fileInfo).slice(0, 700));
      return Response.json({ success: false, message: "Не удалось получить сохранённый PDF." }, { status: 502 });
    }

    const fileResponse = await fetch("https://api.telegram.org/file/bot" + botToken + "/" + fileInfo.result.file_path);
    if (!fileResponse.ok) {
      console.error("Telegram PDF download failed:", fileResponse.status);
      return Response.json({ success: false, message: "Не удалось загрузить сохранённый PDF." }, { status: 502 });
    }

    return new Response(fileResponse.body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="reshai360-report.pdf"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    console.error("Get saved report error:", error);
    return Response.json({ success: false, message: "Не удалось получить сохранённый PDF." }, { status: 500 });
  }
}

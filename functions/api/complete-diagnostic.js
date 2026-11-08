import { ensurePaidOrderLinkExpiry, getOrderExpirationTtl } from "../_lib/telegram-payment.js";
import { syncOrderToGoogleSheets } from "../_lib/google-sheets.js";
export async function onRequestPost({ request, env }) {
  try {
    if (!env.TEST_TOKENS) {
      return Response.json({ success: false, message: "Хранилище диагностики не настроено." }, { status: 503 });
    }

    const body = await request.json();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const input = body.snapshot;

    if (!token || !input || typeof input !== "object" || Array.isArray(input) ||
        !input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) {
      return Response.json({ success: false, message: "Некорректные данные завершения диагностики." }, { status: 400 });
    }

    const snapshot = {
      answers: input.answers,
      marked: Array.isArray(input.marked) ? input.marked : [],
      stats: input.stats && typeof input.stats === "object" && !Array.isArray(input.stats) ? input.stats : {}
    };

    if (JSON.stringify(snapshot).length > 512000) {
      return Response.json({ success: false, message: "Размер результатов превышает допустимый." }, { status: 413 });
    }

    const tokenDataRaw = await env.TEST_TOKENS.get(token);
    if (!tokenDataRaw) {
      return Response.json({ success: false, message: "Ссылка на диагностику недействительна или истекла." }, { status: 403 });
    }

    const tokenData = JSON.parse(tokenDataRaw);
    if (tokenData.isPaid !== true) {
      return Response.json({ success: false, message: "Завершить можно только оплаченную диагностику." }, { status: 403 });
    }

    let changed = false;
    if (tokenData.isCompleted !== true) {
      tokenData.isCompleted = true;
      tokenData.completedAt = new Date().toISOString();
      changed = true;
    }
    // Для старых завершённых заказов без снимка дополняем его при первом повторном открытии.
    if (!tokenData.answersSnapshot) {
      tokenData.answersSnapshot = snapshot;
      changed = true;
    }

    const previousLinkExpiry = Number(tokenData.linkExpiresAt) || null;
    const linkExpiresAt = ensurePaidOrderLinkExpiry(tokenData);
    if (linkExpiresAt <= Date.now()) return Response.json({ success: false, message: "Срок действия ссылки на диагностику истёк." }, { status: 403 });
    if (Number(tokenData.linkExpiresAt) !== previousLinkExpiry) changed = true;
    if (changed) await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: getOrderExpirationTtl(tokenData) });

    const archiveKey = "completed-order:" + token;
    let previousArchive = {};
    try { previousArchive = JSON.parse(await env.TEST_TOKENS.get(archiveKey) || "{}"); } catch {}
    await env.TEST_TOKENS.put(archiveKey, JSON.stringify({
      ...previousArchive,
      email: String(tokenData.email || "").trim().toLowerCase(),
      productKey: tokenData.productKey || previousArchive.productKey || null,
      productTitle: tokenData.productTitle || previousArchive.productTitle || null,
      studentName: tokenData.studentName || previousArchive.studentName || null,
      token,
      isCompleted: true,
      completedAt: tokenData.completedAt || previousArchive.completedAt || new Date().toISOString(),
      paidAt: tokenData.paidAt || previousArchive.paidAt || null,
      linkExpiresAt: tokenData.linkExpiresAt,
      reportReady: previousArchive.reportReady === true,
      promoCodeIssued: tokenData.promoCodeIssued || previousArchive.promoCodeIssued || null
    }), { expirationTtl: 3888000 });
    await syncOrderToGoogleSheets({ env, token, order: tokenData, event: "diagnostic_completed" });

    return Response.json({ success: true, completed: true, completedAt: tokenData.completedAt || null });
  } catch (error) {
    console.error("Complete diagnostic error:", error);
    return Response.json({ success: false, message: "Не удалось сохранить завершение диагностики. Попробуйте ещё раз." }, { status: 500 });
  }
}

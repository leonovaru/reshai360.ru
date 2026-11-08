import { ensurePaidOrderLinkExpiry, getOrderExpirationTtl } from "../_lib/telegram-payment.js";
import { scheduleOrderSync } from "../_lib/google-sheets.js";
export async function onRequestPost(context) {
  const { request, env } = context;
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
      stats: input.stats && typeof input.stats === "object" && !Array.isArray(input.stats) ? input.stats : {},
      diagnosticProfile: input.diagnosticProfile && typeof input.diagnosticProfile === "object" && !Array.isArray(input.diagnosticProfile)
        ? input.diagnosticProfile
        : null
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

    // Бонусный промокод создаётся сразу при завершении диагностики, независимо от PDF и email.
    if (!tokenData.promoCodeIssued) {
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let promoCode = null;
      for (let attempt = 0; attempt < 8 && !promoCode; attempt++) {
        const bytes = new Uint8Array(10);
        crypto.getRandomValues(bytes);
        const candidate = "R360-" + Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
        if (!await env.TEST_TOKENS.get("promo:" + candidate)) promoCode = candidate;
      }
      if (!promoCode) throw new Error("Не удалось сгенерировать промокод");
      await env.TEST_TOKENS.put("promo:" + promoCode, JSON.stringify({
        code: promoCode,
        discountPercent: 10,
        createdAt: Date.now(),
        expiresAt: Date.now() + 45 * 24 * 60 * 60 * 1000,
        used: false,
        reservedBy: null,
        reservedUntil: null
      }), { expirationTtl: 45 * 24 * 60 * 60 });
      tokenData.promoCodeIssued = promoCode;
      changed = true;
    }

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
    scheduleOrderSync(context, { env, token, order: tokenData, event: "diagnostic_completed" });

    return Response.json({ success: true, completed: true, completedAt: tokenData.completedAt || null, promoCode: tokenData.promoCodeIssued || null });
  } catch (error) {
    console.error("Complete diagnostic error:", error);
    return Response.json({ success: false, message: "Не удалось сохранить завершение диагностики. Попробуйте ещё раз." }, { status: 500 });
  }
}

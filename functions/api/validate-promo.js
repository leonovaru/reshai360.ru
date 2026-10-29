export async function onRequestPost({ request, env }) {
  try {
    const { code: rawCode, productKey } = await request.json();
    const code = String(rawCode || "").trim().toUpperCase();

    const displayPrices = {
      "10_basic": 790,
      "10_advanced": 990,
      "11_basic": 790,
      "11_advanced": 990
    };

    if (!/^[A-Z0-9-]{5,24}$/.test(code)) {
      return Response.json({ valid: false, message: "Проверьте формат промокода." }, { status: 400 });
    }

    const basePrice = displayPrices[productKey];
    if (!basePrice) {
      return Response.json({ valid: false, message: "Промокод можно применить к доступной диагностике." }, { status: 400 });
    }

    if (!env.TEST_TOKENS) {
      return Response.json({ valid: false, message: "Хранилище промокодов пока не настроено." }, { status: 503 });
    }

    const raw = await env.TEST_TOKENS.get("promo:" + code);
    if (!raw) {
      return Response.json({ valid: false, message: "Такого промокода нет или срок его действия закончился." }, { status: 404 });
    }

    const promo = JSON.parse(raw);
    const now = Date.now();
    if (promo.expiresAt && promo.expiresAt <= now) {
      return Response.json({ valid: false, message: "Срок действия промокода закончился." }, { status: 410 });
    }
    if (promo.used) {
      return Response.json({ valid: false, message: "Этот промокод уже использован." }, { status: 409 });
    }
    if (promo.reservedUntil && promo.reservedUntil > now) {
      return Response.json({ valid: false, message: "Промокод уже оформляется в другом заказе. Попробуйте через несколько минут." }, { status: 409 });
    }

    const discount = Math.min(Number(promo.discount) || 190, basePrice);
    return Response.json({ valid: true, discount, finalPrice: basePrice - discount });
  } catch (error) {
    console.error("Validate promo error:", error);
    return Response.json({ valid: false, message: "Не удалось проверить промокод." }, { status: 500 });
  }
}

const DEFAULT_PARTNERS = [
  { code: "partner01", name: "Партнёр 1", active: true },
  { code: "partner02", name: "Партнёр 2", active: true },
  { code: "partner03", name: "Партнёр 3", active: true },
  { code: "partner04", name: "Партнёр 4", active: true },
  { code: "partner05", name: "Партнёр 5", active: true }
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function authorized(request, env) {
  const expected = String(env.PARTNER_ADMIN_TOKEN || "");
  const received = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return expected.length >= 24 && received.length === expected.length && received === expected;
}

async function listValues(kv, prefix) {
  const values = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys || []) {
      const raw = await kv.get(key.name);
      if (raw) {
        try { values.push(JSON.parse(raw)); } catch (_) {}
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return values;
}

async function ensureDefaultPartners(kv) {
  for (const item of DEFAULT_PARTNERS) {
    const key = "partner:profile:" + item.code;
    if (!(await kv.get(key))) {
      await kv.put(key, JSON.stringify({ ...item, createdAt: new Date().toISOString() }));
    }
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.TEST_TOKENS) return json({ message: "KV TEST_TOKENS не настроен." }, 503);
  if (!env.PARTNER_ADMIN_TOKEN || String(env.PARTNER_ADMIN_TOKEN).length < 24) {
    return json({ message: "Сначала задайте секрет PARTNER_ADMIN_TOKEN в настройках Cloudflare Pages." }, 503);
  }
  if (!authorized(request, env)) return json({ message: "Нет доступа." }, 401);

  try {
    await ensureDefaultPartners(env.TEST_TOKENS);

    if (request.method === "GET") {
      const partners = (await listValues(env.TEST_TOKENS, "partner:profile:"))
        .sort((a, b) => String(a.code).localeCompare(String(b.code)));
      const commissions = (await listValues(env.TEST_TOKENS, "partner:commission:"))
        .sort((a, b) => String(b.paidAt || b.createdAt).localeCompare(String(a.paidAt || a.createdAt)));
      return json({ partners, commissions });
    }

    if (request.method !== "POST") return json({ message: "Метод не поддерживается." }, 405);
    const body = await request.json();
    const action = String(body.action || "");

    if (action === "create") {
      const name = String(body.name || "").trim().slice(0, 100);
      const code = String(body.code || "").trim().toLowerCase();
      if (name.length < 2) return json({ message: "Укажите имя партнёра (не менее 2 символов)." }, 400);
      if (!/^[a-z0-9_-]{3,32}$/.test(code)) return json({ message: "Код: 3–32 символа, латинские буквы, цифры, дефис или подчёркивание." }, 400);
      const key = "partner:profile:" + code;
      if (await env.TEST_TOKENS.get(key)) return json({ message: "Такой код партнёра уже существует." }, 409);
      const partner = { code, name, active: true, createdAt: new Date().toISOString() };
      await env.TEST_TOKENS.put(key, JSON.stringify(partner));
      return json({ success: true, partner });
    }

    if (action === "rename") {
      const code = String(body.code || "").trim().toLowerCase();
      const name = String(body.name || "").trim().slice(0, 100);
      if (!/^[a-z0-9_-]{3,32}$/.test(code) || name.length < 2) return json({ message: "Проверьте код и имя партнёра." }, 400);
      const key = "partner:profile:" + code;
      const raw = await env.TEST_TOKENS.get(key);
      if (!raw) return json({ message: "Партнёр не найден." }, 404);
      const partner = JSON.parse(raw);
      partner.name = name;
      partner.updatedAt = new Date().toISOString();
      await env.TEST_TOKENS.put(key, JSON.stringify(partner));
      return json({ success: true, partner });
    }

    if (action === "toggle") {
      const code = String(body.code || "").trim().toLowerCase();
      const key = "partner:profile:" + code;
      const raw = await env.TEST_TOKENS.get(key);
      if (!raw) return json({ message: "Партнёр не найден." }, 404);
      const partner = JSON.parse(raw);
      partner.active = partner.active === false;
      partner.updatedAt = new Date().toISOString();
      await env.TEST_TOKENS.put(key, JSON.stringify(partner));
      return json({ success: true, partner });
    }

    if (action === "mark-paid") {
      const code = String(body.code || "").trim().toLowerCase();
      const commissions = await listValues(env.TEST_TOKENS, "partner:commission:");
      const pending = commissions.filter(item => item.partnerCode === code && item.status === "accrued");
      if (!pending.length) return json({ success: false, message: "Нет начислений, ожидающих выплаты." }, 409);
      const payoutId = crypto.randomUUID();
      const paidAt = new Date().toISOString();
      for (const item of pending) {
        await env.TEST_TOKENS.put("partner:commission:" + item.paymentId, JSON.stringify({
          ...item, status: "paid", payoutId, paidAt
        }));
      }
      return json({ success: true, count: pending.length, amount: pending.reduce((sum, item) => sum + Number(item.amount || 0), 0), payoutId });
    }

    return json({ message: "Неизвестное действие." }, 400);
  } catch (error) {
    console.error("Partner admin error:", error);
    return json({ message: "Не удалось выполнить операцию партнёрской программы." }, 500);
  }
}

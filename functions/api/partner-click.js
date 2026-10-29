export async function onRequestPost({ request, env }) {
  try {
    if (!env.TEST_TOKENS) return Response.json({ success: false }, { status: 503 });
    const body = await request.json();
    const code = String(body.referralCode || "").trim().toLowerCase();
    const visitorId = String(body.visitorId || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(code) || !/^[a-f0-9-]{36}$/.test(visitorId)) {
      return Response.json({ success: false }, { status: 400 });
    }
    const partnerRaw = await env.TEST_TOKENS.get("partner:profile:" + code);
    if (!partnerRaw) return Response.json({ success: false }, { status: 404 });
    const partner = JSON.parse(partnerRaw);
    if (partner.active === false) return Response.json({ success: false }, { status: 410 });

    // Один учётный переход на пару «браузер + партнёр», без срока истечения.
    const key = "partner:click:" + code + ":" + visitorId;
    if (!(await env.TEST_TOKENS.get(key))) {
      await env.TEST_TOKENS.put(key, JSON.stringify({
        partnerCode: code,
        visitorId,
        firstSeenAt: new Date().toISOString()
      }));
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Partner click error:", error);
    return Response.json({ success: false }, { status: 500 });
  }
}

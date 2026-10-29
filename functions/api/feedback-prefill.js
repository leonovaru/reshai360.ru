export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();

  if (!/^[a-f0-9]{32}$/i.test(token) || !env.TEST_TOKENS) {
    return Response.json(
      { success: false, message: "Ссылка для предзаполнения недействительна." },
      { status: 400, headers: { "Cache-Control": "no-store, private" } }
    );
  }

  try {
    const raw = await env.TEST_TOKENS.get("feedback-prefill:" + token);
    if (!raw) {
      return Response.json(
        { success: false, message: "Срок действия ссылки истёк. Заполните поля вручную." },
        { status: 404, headers: { "Cache-Control": "no-store, private" } }
      );
    }

    const data = JSON.parse(raw);
    return Response.json(
      {
        success: true,
        name: String(data.name || "").slice(0, 200),
        email: String(data.email || "").slice(0, 320)
      },
      {
        headers: {
          "Cache-Control": "no-store, private",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer"
        }
      }
    );
  } catch (error) {
    console.error("Feedback prefill lookup failed:", error);
    return Response.json(
      { success: false, message: "Не удалось загрузить данные для формы." },
      { status: 500, headers: { "Cache-Control": "no-store, private" } }
    );
  }
}

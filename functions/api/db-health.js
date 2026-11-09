// Read-only D1 connectivity check for the Preview environment.
// Does not expose database contents or accept writes.
export async function onRequestGet({ env }) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };

  if (!env.DB || typeof env.DB.prepare !== "function") {
    return new Response(
      JSON.stringify({ ok: false, code: "D1_BINDING_MISSING" }),
      { status: 503, headers }
    );
  }

  try {
    const row = await env.DB.prepare("SELECT 1 AS connected").first();

    if (row?.connected !== 1) {
      return new Response(
        JSON.stringify({ ok: false, code: "D1_UNEXPECTED_RESPONSE" }),
        { status: 503, headers }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, service: "diagnostics-db", connected: true }),
      { status: 200, headers }
    );
  } catch {
    // Do not return provider details, SQL text, or environment configuration.
    return new Response(
      JSON.stringify({ ok: false, code: "D1_QUERY_FAILED" }),
      { status: 503, headers }
    );
  }
}

export async function onRequest({ request }) {
  if (request.method === "GET") {
    return onRequestGet({ env: {} });
  }

  return new Response(null, {
    status: 405,
    headers: { allow: "GET", "cache-control": "no-store" },
  });
}

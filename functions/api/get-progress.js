import { getPaidGrade7Order, isGrade7V2Product, progressErrorResponse } from "../_lib/grade7-d1-progress.js";

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
    if (isGrade7V2Product(tokenData.productKey)) {
      const access = await getPaidGrade7Order(env, token);
      if (access.error) return progressErrorResponse(access.error, access.status);
      const diagnostic = access.diagnostic;
      const progress = await env.DB.prepare(`
        SELECT revision, status, drafts_json, marked_json, updated_at
        FROM diagnostic_progress
        WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
      `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).first();
      const completion = await env.DB.prepare(`
        SELECT snapshot_json, completed_at
        FROM diagnostic_completions
        WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
      `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).first();
      let snapshot = null;
      if (progress) {
        let drafts = {};
        let marked = [];
        try { drafts = JSON.parse(progress.drafts_json || "{}"); } catch {}
        try { marked = JSON.parse(progress.marked_json || "[]"); } catch {}
        snapshot = {
          version: 2,
          answers: drafts.answers && typeof drafts.answers === "object" ? drafts.answers : {},
          stats: drafts.stats && typeof drafts.stats === "object" ? drafts.stats : {},
          marked: Array.isArray(marked) ? marked : [],
          savedAt: Number(drafts.savedAt) || Date.parse(progress.updated_at || "") || null,
          revision: Number(progress.revision || 0)
        };
      }
      let answersSnapshot = null;
      if (completion?.snapshot_json) {
        try { answersSnapshot = JSON.parse(completion.snapshot_json); } catch {}
      }
      const completed = Boolean(completion) || progress?.status === "COMPLETED" || tokenData.isCompleted === true;
      return Response.json({
        success: true,
        snapshot,
        completed,
        completedAt: completion?.completed_at || tokenData.completedAt || null,
        answersSnapshot
      }, { headers });
    }
    if (tokenData.isPaid !== true) return Response.json({ success: false, message: "Доступ к прогрессу не подтверждён." }, { status: 403, headers });

    const progressRaw = await env.TEST_TOKENS.get("progress:" + token);
    let snapshot = null;
    if (progressRaw) {
      try { snapshot = JSON.parse(progressRaw); } catch (_) {}
    }

    return Response.json({
      success: true,
      snapshot,
      completed: tokenData.isCompleted === true,
      completedAt: tokenData.completedAt || null,
      answersSnapshot: tokenData.isCompleted === true ? (tokenData.answersSnapshot || null) : null
    }, { headers });
  } catch (error) {
    console.error("Get diagnostic progress error:", error);
    return Response.json({ success: false, message: "Не удалось получить прогресс." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

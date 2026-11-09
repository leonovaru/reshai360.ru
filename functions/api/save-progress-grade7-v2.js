import { getPaidGrade7Order, validateGrade7ProgressSnapshot, progressErrorResponse } from "../_lib/grade7-d1-progress.js";

export async function onRequestPost({ request, env }) {
  try {
    let body;
    try { body = await request.json(); } catch { return progressErrorResponse("INVALID_SNAPSHOT", 400); }
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) return progressErrorResponse("INVALID_TOKEN", 403);

    const access = await getPaidGrade7Order(env, token);
    if (access.error) return progressErrorResponse(access.error, access.status);

    const validated = validateGrade7ProgressSnapshot(body.snapshot, access.order.productKey);
    if (validated.error) return progressErrorResponse(validated.error, 400);

    const snapshot = {
      version: 2,
      answers: validated.snapshot.answers,
      stats: validated.snapshot.stats,
      savedAt: Date.now()
    };
    const draftsJson = JSON.stringify(snapshot);
    const markedJson = JSON.stringify(validated.snapshot.marked);
    if (draftsJson.length + markedJson.length > 512000) {
      return Response.json({ success: false, message: "Размер прогресса превышает допустимый." }, {
        status: 413, headers: { "Cache-Control": "no-store" }
      });
    }

    const diagnostic = access.diagnostic;
    const operationId = crypto.randomUUID();
    const result = await env.DB.prepare(`
      INSERT INTO diagnostic_progress (
        token, diagnostic_id, diagnostic_version, revision, status,
        drafts_json, marked_json, last_operation_id, schema_version
      ) VALUES (?, ?, ?, 1, 'IN_PROGRESS', ?, ?, ?, 2)
      ON CONFLICT(token, diagnostic_id, diagnostic_version) DO UPDATE SET
        revision = diagnostic_progress.revision + 1,
        drafts_json = excluded.drafts_json,
        marked_json = excluded.marked_json,
        last_operation_id = excluded.last_operation_id,
        updated_at = CURRENT_TIMESTAMP
      WHERE diagnostic_progress.status = 'IN_PROGRESS'
    `).bind(
      token,
      diagnostic.diagnosticId,
      diagnostic.diagnosticVersion,
      draftsJson,
      markedJson,
      operationId
    ).run();

    if (!result.success) throw new Error("D1 progress write failed");
    if (Number(result.meta?.changes || 0) === 0) {
      return Response.json({ success: false, completed: true, message: "Диагностика уже завершена." }, {
        status: 409, headers: { "Cache-Control": "no-store" }
      });
    }

    const row = await env.DB.prepare(`
      SELECT revision, updated_at
      FROM diagnostic_progress
      WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
    `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).first();

    return Response.json({
      success: true,
      savedAt: snapshot.savedAt,
      revision: Number(row?.revision || 1)
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Save grade 7 D1 progress error:", error);
    return Response.json({ success: false, message: "Не удалось сохранить прогресс." }, {
      status: 500, headers: { "Cache-Control": "no-store" }
    });
  }
}

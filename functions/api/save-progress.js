import { ensurePaidOrderLinkExpiry, getOrderExpirationTtl } from "../_lib/telegram-payment.js";
import { getPaidGrade7Order, isGrade7V2Product, validateGrade7ProgressSnapshot, progressErrorResponse } from "../_lib/grade7-d1-progress.js";
export async function onRequestPost({ request, env }) {
  try {
    if (!env.TEST_TOKENS) {
      return Response.json({ success: false, message: "Хранилище прогресса не настроено." }, { status: 503 });
    }

    const body = await request.json();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const input = body.snapshot;

    if (!token || !input || typeof input !== "object" || Array.isArray(input)) {
      return Response.json({ success: false, message: "Некорректные данные прогресса." }, { status: 400 });
    }

    const snapshot = {
      version: 1,
      answers: input.answers && typeof input.answers === "object" && !Array.isArray(input.answers) ? input.answers : {},
      marked: Array.isArray(input.marked) ? input.marked : [],
      stats: input.stats && typeof input.stats === "object" && !Array.isArray(input.stats) ? input.stats : {},
      savedAt: Date.now()
    };

    if (JSON.stringify(snapshot).length > 512000) {
      return Response.json({ success: false, message: "Размер прогресса превышает допустимый." }, { status: 413 });
    }

    const tokenDataRaw = await env.TEST_TOKENS.get(token);
    if (!tokenDataRaw) {
      return Response.json({ success: false, message: "Ссылка недействительна или срок её действия истёк." }, { status: 403 });
    }

    const tokenData = JSON.parse(tokenDataRaw);
    if (isGrade7V2Product(tokenData.productKey)) {
      const access = await getPaidGrade7Order(env, token, request);
      if (access.error) return progressErrorResponse(access.error, access.status);
      const validated = validateGrade7ProgressSnapshot(input, tokenData.productKey);
      if (validated.error) return progressErrorResponse(validated.error, 400);
      const snapshotV2 = {
        version: 2,
        answers: validated.snapshot.answers,
        stats: validated.snapshot.stats,
        savedAt: Date.now()
      };
      const draftsJson = JSON.stringify(snapshotV2);
      const markedJson = JSON.stringify(validated.snapshot.marked);
      if (draftsJson.length + markedJson.length > 512000) {
        return Response.json({ success: false, message: "Размер прогресса превышает допустимый." }, { status: 413 });
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
      `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion, draftsJson, markedJson, operationId).run();
      if (!result.success) throw new Error("D1 progress write failed");
      if (Number(result.meta?.changes || 0) === 0) {
        return Response.json({ success: false, completed: true, message: "Диагностика уже завершена." }, { status: 409 });
      }
      const row = await env.DB.prepare(`
        SELECT revision FROM diagnostic_progress
        WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
      `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).first();
      return Response.json({ success: true, savedAt: snapshotV2.savedAt, revision: Number(row?.revision || 1) });
    }
    if (tokenData.isPaid !== true) return Response.json({ success: false, message: "Прогресс можно сохранить только для оплаченной диагностики." }, { status: 403 });
    const linkExpiresAt = ensurePaidOrderLinkExpiry(tokenData);
    if (linkExpiresAt <= Date.now()) return Response.json({ success: false, message: "Срок действия ссылки на диагностику истёк." }, { status: 403 });
    if (tokenData.isCompleted === true) {
      return Response.json({ success: false, completed: true, message: "Диагностика уже завершена." }, { status: 409 });
    }

    const progressKey = "progress:" + token;
    const previousRaw = await env.TEST_TOKENS.get(progressKey);
    const previousSnapshot = previousRaw ? JSON.parse(previousRaw) : null;
    const mergedAnswers = { ...(previousSnapshot && previousSnapshot.answers || {}) };
    Object.entries(snapshot.answers).forEach(([questionId, answer]) => {
      if (answer === null) delete mergedAnswers[questionId];
      else mergedAnswers[questionId] = answer;
    });
    const savedAt = Date.now();
    const mergedSnapshot = {
      version: 1,
      answers: mergedAnswers,
      marked: snapshot.marked,
      stats: { ...(previousSnapshot && previousSnapshot.stats || {}), ...snapshot.stats },
      savedAt
    };
    await env.TEST_TOKENS.put(progressKey, JSON.stringify(mergedSnapshot), { expirationTtl: getOrderExpirationTtl(tokenData) });
    return Response.json({ success: true, savedAt });
  } catch (error) {
    console.error("Save diagnostic progress error:", error);
    return Response.json({ success: false, message: "Не удалось сохранить прогресс." }, { status: 500 });
  }
}

import { getPaidGrade7Order, progressErrorResponse } from "../_lib/grade7-d1-progress.js";
import { resolveGrade7Question, scoreGrade7Answer } from "../_lib/grade7-diagnostic-bank.js";

function jsonError(message, status) {
  return Response.json({ success: false, message }, {
    status, headers: { "Cache-Control": "no-store" }
  });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  try {
    let body;
    try { body = await request.json(); } catch { return jsonError("Некорректный запрос.", 400); }
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const questionId = typeof body?.questionId === "string" ? body.questionId : "";
    const operationId = typeof body?.operationId === "string" ? body.operationId : "";
    const submitted = body?.answer;
    if (!token || !questionId || !/^[A-Za-z0-9_-]{12,100}$/.test(operationId)) {
      return jsonError("Не хватает данных для проверки ответа.", 400);
    }
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted) ||
        !["text", "radio"].includes(submitted.type)) {
      return jsonError("Некорректный формат ответа.", 400);
    }
    if (submitted.type === "text" && (typeof submitted.value !== "string" || submitted.value.length > 2000)) {
      return jsonError("Некорректный формат ответа.", 400);
    }
    if (submitted.type === "radio" && !(typeof submitted.value === "string" || Number.isInteger(submitted.value))) {
      return jsonError("Некорректный формат ответа.", 400);
    }

    const access = await getPaidGrade7Order(env, token);
    if (access.error) return progressErrorResponse(access.error, access.status);
    const diagnostic = access.diagnostic;
    const question = resolveGrade7Question(access.order.productKey, questionId);
    if (!question) return jsonError("Задание не найдено в этой диагностике.", 400);

    const answer = {
      type: submitted.type,
      value: submitted.type === "text" ? submitted.value.trim() : String(submitted.value)
    };
    const correctness = scoreGrade7Answer(question, answer);
    if (correctness === "UNASSESSED") return jsonError("Ответ не удалось проверить. Проверьте формат.", 400);

    const requestHash = await sha256(JSON.stringify({ questionId, answer }));
    const previous = await env.DB.prepare(`
      SELECT request_hash, response_json
      FROM diagnostic_operations
      WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND operation_id = ?
    `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion, operationId).first();

    if (previous) {
      if (previous.request_hash !== requestHash) return jsonError("Идентификатор операции уже использован для другого ответа.", 409);
      try {
        const response = JSON.parse(previous.response_json);
        return Response.json({ ...response, idempotent: true }, { headers: { "Cache-Control": "no-store" } });
      } catch { return jsonError("Не удалось восстановить результат операции.", 500); }
    }

    const progress = await env.DB.prepare(`
      SELECT status, revision FROM diagnostic_progress
      WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
    `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).first();
    if (!progress) return jsonError("Сначала сохраните прогресс диагностики.", 409);
    if (progress.status !== "IN_PROGRESS") return jsonError("Диагностика уже завершена.", 409);

    const attemptId = crypto.randomUUID();
    const responsePayload = {
      success: true,
      questionId,
      correctness,
      feedback: correctness === "CORRECT" ? "Верно" : "Попробуй ещё раз"
    };
    const responseJson = JSON.stringify(responsePayload);
    const now = new Date().toISOString();

    const operationInsert = env.DB.prepare(`
      INSERT INTO diagnostic_operations (
        token, diagnostic_id, diagnostic_version, operation_id,
        operation_type, request_hash, response_json, created_at
      )
      SELECT ?, ?, ?, ?, 'CHECK_ANSWER', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM diagnostic_progress
        WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND status = 'IN_PROGRESS'
      )
      ON CONFLICT(token, diagnostic_id, diagnostic_version, operation_id) DO NOTHING
    `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion, operationId,
      requestHash, responseJson, now, token, diagnostic.diagnosticId, diagnostic.diagnosticVersion);

    const attemptInsert = env.DB.prepare(`
      INSERT INTO diagnostic_attempts (
        attempt_id, token, diagnostic_id, diagnostic_version, question_id,
        component_id, attempt_number, operation_id, submitted_value_json,
        correctness, source, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(attempt_number), 0) + 1, ?, ?, ?, 'STUDENT_CHECK', ?
      FROM diagnostic_attempts
      WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND question_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM diagnostic_attempts
          WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND operation_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM diagnostic_operations
          WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND operation_id = ?
            AND request_hash = ?
        )
        AND EXISTS (
          SELECT 1 FROM diagnostic_progress
          WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND status = 'IN_PROGRESS'
        )
    `).bind(
      attemptId, token, diagnostic.diagnosticId, diagnostic.diagnosticVersion,
      questionId, question.topicId, operationId, JSON.stringify(answer), correctness, now,
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion, questionId,
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion, operationId,
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion, operationId, requestHash,
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion
    );

    const results = await env.DB.batch([operationInsert, attemptInsert]);
    if (results.some(result => !result.success)) throw new Error("D1 attempt transaction failed");

    const stored = await env.DB.prepare(`
      SELECT a.correctness, a.attempt_number, o.request_hash, o.response_json
      FROM diagnostic_operations o
      LEFT JOIN diagnostic_attempts a
        ON a.token = o.token AND a.diagnostic_id = o.diagnostic_id
        AND a.diagnostic_version = o.diagnostic_version AND a.operation_id = o.operation_id
      WHERE o.token = ? AND o.diagnostic_id = ? AND o.diagnostic_version = ? AND o.operation_id = ?
    `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion, operationId).first();

    if (!stored || stored.request_hash !== requestHash || !stored.correctness) {
      return jsonError("Диагностика уже завершена или операция не была сохранена. Обновите страницу.", 409);
    }
    return Response.json({
      success: true,
      questionId,
      correctness: stored.correctness,
      feedback: stored.correctness === "CORRECT" ? "Верно" : "Попробуй ещё раз",
      attemptNumber: Number(stored.attempt_number || 1)
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Grade 7 answer check failed:", error);
    return jsonError("Не удалось проверить ответ. Попробуйте ещё раз.", 500);
  }
}

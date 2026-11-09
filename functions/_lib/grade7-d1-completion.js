import { getPaidGrade7Order, validateGrade7ProgressSnapshot } from "./grade7-d1-progress.js";
import { listGrade7Questions, scoreGrade7Answer } from "./grade7-diagnostic-bank.js";

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function completeGrade7InD1(env, token, input) {
  const access = await getPaidGrade7Order(env, token);
  if (access.error) return { error: access.error, status: access.status };
  const diagnostic = access.diagnostic;
  const validated = validateGrade7ProgressSnapshot(input, access.order.productKey);
  if (validated.error) return { error: validated.error, status: 400 };

  const existing = await env.DB.prepare(`
    SELECT snapshot_json, completed_at
    FROM diagnostic_completions
    WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
  `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).first();
  if (existing?.snapshot_json) {
    try { return { snapshot: JSON.parse(existing.snapshot_json), completedAt: existing.completed_at, existing: true, order: access.order }; }
    catch { return { error: "COMPLETION_CORRUPTED", status: 500 }; }
  }

  const progress = await env.DB.prepare(`
    SELECT status, revision, drafts_json, marked_json
    FROM diagnostic_progress
    WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
  `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).first();
  if (progress && progress.status !== "IN_PROGRESS") return { error: "ALREADY_LOCKED", status: 409 };

  let savedDrafts = {};
  try { savedDrafts = JSON.parse(progress?.drafts_json || "{}"); } catch {}
  const mergedAnswers = {
    ...(savedDrafts.answers && typeof savedDrafts.answers === "object" && !Array.isArray(savedDrafts.answers)
      ? savedDrafts.answers : {})
  };
  for (const [questionId, answer] of Object.entries(validated.snapshot.answers)) {
    if (answer === null) delete mergedAnswers[questionId];
    else mergedAnswers[questionId] = answer;
  }

  const questions = listGrade7Questions(access.order.productKey);
  const questionResults = [];
  const answers = {};
  const scoring = { correct: 0, incorrect: 0, unassessed: 0 };
  for (const question of questions) {
    const answer = mergedAnswers[question.questionId] || null;
    const correctness = answer ? scoreGrade7Answer(question, answer) : "UNASSESSED";
    if (answer) answers[question.questionId] = answer;
    if (correctness === "CORRECT") scoring.correct++;
    else if (correctness === "INCORRECT") scoring.incorrect++;
    else scoring.unassessed++;
    questionResults.push({
      questionId: question.questionId,
      topicId: question.topicId,
      topicName: question.topicName,
      blockName: question.blockName,
      answer,
      correctness
    });
  }

  // История проверок берётся только из D1; данные браузера не могут её подменить.
  const attemptRows = await env.DB.prepare(`
    SELECT question_id, submitted_value_json, correctness, attempt_number
    FROM diagnostic_attempts
    WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND source = 'USER_CHECK'
    ORDER BY question_id ASC, attempt_number ASC
  `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).all();
  const questionsById = new Map(questions.map(question => [question.questionId, question]));
  const attemptsByQuestion = new Map();
  for (const row of attemptRows.results || []) {
    if (!attemptsByQuestion.has(row.question_id)) attemptsByQuestion.set(row.question_id, []);
    let submitted = null;
    try { submitted = JSON.parse(row.submitted_value_json || "null"); } catch {}
    const question = questionsById.get(row.question_id);
    let displayValue = "";
    if (submitted?.type === "radio") {
      const selectedIndex = Number(submitted.value);
      displayValue = question?.options?.[selectedIndex] == null
        ? String(submitted.value ?? "")
        : String(question.options[selectedIndex]);
    } else if (submitted?.type === "text") {
      displayValue = String(submitted.value ?? "").trim().replace(/\\./g, ",");
    }
    attemptsByQuestion.get(row.question_id).push({
      displayValue,
      correctness: row.correctness,
      attemptNumber: Number(row.attempt_number || 0)
    });
  }
  const correctnessByQuestion = new Map(questionResults.map(item => [item.questionId, item.correctness]));
  const stats = {};
  for (const question of questions) {
    const history = attemptsByQuestion.get(question.questionId) || [];
    const finalCorrect = correctnessByQuestion.get(question.questionId) === "CORRECT";
    stats[question.questionId] = {
      checkCount: history.length,
      attemptsHistory: history.map(item => item.displayValue).filter(Boolean).slice(-20),
      isCorrect: finalCorrect,
      selfCorrected: finalCorrect && history.some(item => item.correctness === "INCORRECT")
    };
  }

  const completedAt = new Date().toISOString();
  const completionId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const snapshot = {
    schemaVersion: 2,
    diagnosticId: diagnostic.diagnosticId,
    diagnosticVersion: diagnostic.diagnosticVersion,
    bankVersion: diagnostic.diagnosticVersion,
    scoringVersion: "grade7-server-score-v1",
    reportVersion: "grade7-report-v2",
    completionId,
    completedAt,
    level: diagnostic.level,
    questions: questionResults,
    answers,
    marked: validated.snapshot.marked,
    stats,
    scoring,
    reportMetadata: { questionCount: questions.length, answeredCount: Object.keys(answers).length }
  };
  const snapshotJson = JSON.stringify(snapshot);
  if (snapshotJson.length > 1024 * 1024) return { error: "COMPLETION_TOO_LARGE", status: 413 };
  const checksum = await sha256(snapshotJson);
  const requestHash = await sha256(JSON.stringify({ answers, marked: snapshot.marked }));
  const now = completedAt;

  const statements = [
    env.DB.prepare(`
      INSERT INTO diagnostic_progress (
        token, diagnostic_id, diagnostic_version, revision, status,
        drafts_json, marked_json, last_operation_id, schema_version
      ) VALUES (?, ?, ?, 1, 'IN_PROGRESS', ?, ?, ?, 2)
      ON CONFLICT(token, diagnostic_id, diagnostic_version) DO NOTHING
    `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion,
      JSON.stringify({ version: 2, answers, stats: {} }), JSON.stringify(snapshot.marked), operationId),
    env.DB.prepare(`
      INSERT INTO diagnostic_operations (
        token, diagnostic_id, diagnostic_version, operation_id,
        operation_type, request_hash, response_json, created_at
      )
      SELECT ?, ?, ?, ?, 'COMPLETE', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM diagnostic_progress
        WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND status = 'IN_PROGRESS'
      )
    `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion, operationId,
      requestHash, JSON.stringify({ success: true, completionId, completedAt }), now,
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion),
    env.DB.prepare(`
      INSERT INTO diagnostic_attempts (
        attempt_id, token, diagnostic_id, diagnostic_version, question_id,
        component_id, attempt_number, operation_id, submitted_value_json,
        correctness, source, created_at
      )
      SELECT
        json_extract(value, '$.attemptId'), ?, ?, ?, json_extract(value, '$.questionId'),
        json_extract(value, '$.topicId'),
        (SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM diagnostic_attempts a
         WHERE a.token = ? AND a.diagnostic_id = ? AND a.diagnostic_version = ?
           AND a.question_id = json_extract(value, '$.questionId')),
        json_extract(value, '$.operationId'), json_extract(value, '$.answerJson'),
        json_extract(value, '$.correctness'), 'FINALIZE_DRAFT', ?
      FROM json_each(?)
      WHERE EXISTS (
        SELECT 1 FROM diagnostic_progress
        WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND status = 'IN_PROGRESS'
      )
        AND NOT EXISTS (
          SELECT 1 FROM diagnostic_attempts a
          WHERE a.token = ? AND a.diagnostic_id = ? AND a.diagnostic_version = ?
            AND a.question_id = json_extract(value, '$.questionId')
            AND a.submitted_value_json = json_extract(value, '$.answerJson')
        )
    `).bind(
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion,
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion,
      now, JSON.stringify(questionResults.filter(item => item.answer).map(item => ({
        attemptId: crypto.randomUUID(),
        questionId: item.questionId,
        topicId: item.topicId,
        operationId: "final-" + completionId + "-" + item.questionId,
        answerJson: JSON.stringify(item.answer),
        correctness: item.correctness
      }))),
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion,
      token, diagnostic.diagnosticId, diagnostic.diagnosticVersion
    ),
    env.DB.prepare(`
      INSERT INTO diagnostic_completions (
        completion_id, token, diagnostic_id, diagnostic_version,
        schema_version, snapshot_json, snapshot_checksum, completed_at
      )
      SELECT ?, ?, ?, ?, 2, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM diagnostic_progress
        WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND status = 'IN_PROGRESS'
      )
    `).bind(completionId, token, diagnostic.diagnosticId, diagnostic.diagnosticVersion,
      snapshotJson, checksum, completedAt, token, diagnostic.diagnosticId, diagnostic.diagnosticVersion),
    env.DB.prepare(`
      UPDATE diagnostic_progress
      SET status = 'COMPLETED', revision = revision + 1,
          last_operation_id = ?, updated_at = ?
      WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ? AND status = 'IN_PROGRESS'
    `).bind(operationId, now, token, diagnostic.diagnosticId, diagnostic.diagnosticVersion)
  ];

  try {
    const results = await env.DB.batch(statements);
    if (results.some(result => !result.success)) throw new Error("D1 completion batch failed");
  } catch (error) {
    const raced = await env.DB.prepare(`
      SELECT snapshot_json, completed_at
      FROM diagnostic_completions
      WHERE token = ? AND diagnostic_id = ? AND diagnostic_version = ?
    `).bind(token, diagnostic.diagnosticId, diagnostic.diagnosticVersion).first();
    if (raced?.snapshot_json) {
      try { return { snapshot: JSON.parse(raced.snapshot_json), completedAt: raced.completed_at, existing: true, order: access.order }; }
      catch { return { error: "COMPLETION_CORRUPTED", status: 500 }; }
    }
    console.error("D1 grade 7 completion batch failed:", error);
    return { error: "COMPLETION_FAILED", status: 500 };
  }

  return { snapshot, completedAt, existing: false, order: access.order };
}

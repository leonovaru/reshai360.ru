// Read-only validation of the grade 7 D1 schema in Preview.
const REQUIRED_TABLES = [
  "diagnostic_progress",
  "diagnostic_attempts",
  "diagnostic_completions",
  "report_deliveries",
  "promo_issuances",
  "diagnostic_operations",
  "outbox_events",
  "legacy_migrations"
];
const REQUIRED_TRIGGERS = [
  "trg_attempt_id_not_null",
  "trg_attempt_id_not_null_update",
  "trg_completion_id_not_null",
  "trg_completion_id_not_null_update",
  "trg_delivery_id_not_null",
  "trg_delivery_id_not_null_update",
  "trg_issuance_id_not_null",
  "trg_issuance_id_not_null_update",
  "trg_outbox_event_id_not_null",
  "trg_outbox_event_id_not_null_update"
];

export async function onRequestGet({ env }) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (!env.DB || typeof env.DB.prepare !== "function") {
    return Response.json({ ok: false, code: "D1_BINDING_MISSING" }, { status: 503, headers });
  }
  try {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" +
      REQUIRED_TABLES.map(() => "?").join(",") + ")"
    ).bind(...REQUIRED_TABLES).all();
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (" +
      REQUIRED_TRIGGERS.map(() => "?").join(",") + ")"
    ).bind(...REQUIRED_TRIGGERS).all();
    const tableNames = new Set((tables.results || []).map(row => row.name));
    const triggerNames = new Set((triggers.results || []).map(row => row.name));
    const missingTables = REQUIRED_TABLES.filter(name => !tableNames.has(name));
    const missingTriggers = REQUIRED_TRIGGERS.filter(name => !triggerNames.has(name));
    const foreignKeys = await env.DB.prepare("PRAGMA foreign_key_check").all();
    const foreignKeyErrors = (foreignKeys.results || []).length;
    const ok = missingTables.length === 0 && missingTriggers.length === 0 && foreignKeyErrors === 0;
    return Response.json({
      ok,
      service: "diagnostics-d1-schema",
      tables: { expected: REQUIRED_TABLES.length, found: tableNames.size, missing: missingTables },
      nullGuards: { expected: REQUIRED_TRIGGERS.length, found: triggerNames.size, missing: missingTriggers },
      foreignKeyErrors
    }, { status: ok ? 200 : 503, headers });
  } catch {
    return Response.json({ ok: false, code: "D1_SCHEMA_CHECK_FAILED" }, { status: 503, headers });
  }
}

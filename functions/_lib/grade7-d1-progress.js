import { ensurePaidOrderLinkExpiry } from "./telegram-payment.js";
import { getGrade7Diagnostic, listGrade7Questions } from "./grade7-diagnostic-bank.js";

export function isGrade7V2Product(productKey) {
  return productKey === "7_basic_v2" || productKey === "7_advanced_v2";
}

export async function getPaidGrade7Order(env, token, request = null) {
  if (!env.TEST_TOKENS) return { error: "STORE_UNAVAILABLE", status: 503 };
  const raw = await env.TEST_TOKENS.get(token);
  if (!raw) return { error: "INVALID_TOKEN", status: 403 };
  let order;
  try { order = JSON.parse(raw); } catch { return { error: "INVALID_ORDER", status: 403 }; }
  if (order.isPaid !== true) return { error: "NOT_PAID", status: 403 };
  if (order.previewTest === true) {
    let hostname = "";
    try { hostname = new URL(request?.url || "").hostname; } catch {}
    if (!hostname.endsWith(".pages.dev") || hostname === "reshai360-ru.pages.dev") return { error: "PREVIEW_ONLY", status: 403 };
  }
  if (!isGrade7V2Product(order.productKey)) return { error: "NOT_GRADE7_V2", status: 409, order };
  const expiresAt = ensurePaidOrderLinkExpiry(order);
  if (expiresAt <= Date.now()) return { error: "EXPIRED", status: 403 };
  if (!env.DB) return { error: "DATABASE_UNAVAILABLE", status: 503 };
  const diagnostic = getGrade7Diagnostic(order.productKey);
  if (!diagnostic) return { error: "DIAGNOSTIC_UNAVAILABLE", status: 503 };
  return { order, diagnostic };
}

export function validateGrade7ProgressSnapshot(input, productKey) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "INVALID_SNAPSHOT" };
  const allowed = new Set(listGrade7Questions(productKey).map(question => question.questionId));
  const answers = input.answers && typeof input.answers === "object" && !Array.isArray(input.answers) ? input.answers : {};
  const stats = input.stats && typeof input.stats === "object" && !Array.isArray(input.stats) ? input.stats : {};
  const normalizedAnswers = {};
  for (const [questionId, answer] of Object.entries(answers)) {
    if (!allowed.has(questionId)) return { error: "UNKNOWN_QUESTION" };
    if (answer === null) { normalizedAnswers[questionId] = null; continue; }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return { error: "INVALID_ANSWER" };
    if (answer.type === "text" && typeof answer.value === "string" && answer.value.length <= 2000) {
      normalizedAnswers[questionId] = { type: "text", value: answer.value };
    } else if (answer.type === "radio" && (typeof answer.value === "string" || Number.isInteger(answer.value))) {
      normalizedAnswers[questionId] = { type: "radio", value: String(answer.value) };
    } else return { error: "INVALID_ANSWER" };
  }
  const marked = Array.isArray(input.marked) ? input.marked : [];
  if (marked.length > allowed.size || marked.some(id => typeof id !== "string" || !allowed.has(id))) {
    return { error: "INVALID_MARKED_QUESTION" };
  }
  const normalizedStats = {};
  for (const [questionId, value] of Object.entries(stats)) {
    if (!allowed.has(questionId) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    normalizedStats[questionId] = {
      checkCount: Number.isInteger(value.checkCount) && value.checkCount >= 0 ? Math.min(value.checkCount, 100) : 0,
      attemptsHistory: Array.isArray(value.attemptsHistory)
        ? value.attemptsHistory.filter(item => typeof item === "string").slice(-20).map(item => item.slice(0, 2000))
        : [],
      isCorrect: typeof value.isCorrect === "boolean" ? value.isCorrect : null
    };
  }
  return { snapshot: { answers: normalizedAnswers, marked: [...new Set(marked)], stats: normalizedStats } };
}

export function progressErrorResponse(error, status = 500) {
  const messages = {
    STORE_UNAVAILABLE: "Хранилище заказа не настроено.",
    INVALID_TOKEN: "Ссылка недействительна или срок её действия истёк.",
    INVALID_ORDER: "Не удалось проверить заказ.",
    NOT_PAID: "Прогресс доступен только после оплаты.",
    NOT_GRADE7_V2: "Для этой диагностики используется прежнее хранилище.",
    EXPIRED: "Срок действия ссылки на диагностику истёк.",
    DATABASE_UNAVAILABLE: "Хранилище диагностики временно недоступно.",
    DIAGNOSTIC_UNAVAILABLE: "Банк диагностики временно недоступен.",
    INVALID_SNAPSHOT: "Некорректные данные прогресса.",
    UNKNOWN_QUESTION: "В прогрессе обнаружено неизвестное задание.",
    INVALID_ANSWER: "Некорректный формат ответа.",
    INVALID_MARKED_QUESTION: "Некорректный список отмеченных заданий."
  };
  return Response.json({ success: false, message: messages[error] || "Не удалось обработать прогресс." }, {
    status, headers: { "Cache-Control": "no-store" }
  });
}

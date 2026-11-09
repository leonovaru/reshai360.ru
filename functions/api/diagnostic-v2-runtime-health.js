import { isGrade7V2Product } from "../_lib/grade7-d1-progress.js";
import { completeGrade7InD1 } from "../_lib/grade7-d1-completion.js";
import { listGrade7Questions, resolveGrade7Question, scoreGrade7Answer } from "../_lib/grade7-diagnostic-bank.js";
import { onRequestPost as checkAnswerHandler } from "./check-answer-grade7-v2.js";
import { onRequestPost as saveProgressHandler } from "./save-progress.js";
import { onRequestGet as getProgressHandler } from "./get-progress.js";
import { onRequestPost as completeDiagnosticHandler } from "./complete-diagnostic.js";
import { onRequestPost as sendReportHandler } from "./send-report.js";
import { onRequestPost as getReportHandler } from "./get-report.js";

export async function onRequestGet() {
  try {
    const basic = listGrade7Questions("7_basic_v2");
    const advanced = listGrade7Questions("7_advanced_v2");
    const sample = basic[0];
    const scoringWorks = Boolean(sample) &&
      scoreGrade7Answer(sample, sample.questionType === "radio"
        ? { type: "radio", value: String(sample.correctAnswer) }
        : { type: "text", value: String(sample.correctAnswer) }) === "CORRECT";
    const ok = isGrade7V2Product("7_basic_v2") &&
      isGrade7V2Product("7_advanced_v2") &&
      !isGrade7V2Product("7") &&
      typeof completeGrade7InD1 === "function" &&
      typeof checkAnswerHandler === "function" &&
      typeof saveProgressHandler === "function" &&
      typeof getProgressHandler === "function" &&
      typeof completeDiagnosticHandler === "function" &&
      typeof sendReportHandler === "function" &&
      typeof getReportHandler === "function" &&
      basic.length > 0 && advanced.length > 0 &&
      basic.every(question => resolveGrade7Question("7_basic_v2", question.questionId)) &&
      advanced.every(question => resolveGrade7Question("7_advanced_v2", question.questionId)) &&
      scoringWorks;
    return Response.json({
      ok,
      service: "grade7-v2-runtime",
      d1CompletionModuleLoaded: typeof completeGrade7InD1 === "function",
      endpointModulesLoaded: {
        checkAnswer: typeof checkAnswerHandler === "function",
        saveProgress: typeof saveProgressHandler === "function",
        getProgress: typeof getProgressHandler === "function",
        completeDiagnostic: typeof completeDiagnosticHandler === "function",
        sendReport: typeof sendReportHandler === "function",
        getReport: typeof getReportHandler === "function"
      },
      products: {
        basic: { available: basic.length > 0, questionCount: basic.length },
        advanced: { available: advanced.length > 0, questionCount: advanced.length }
      },
      scoringSelfCheck: scoringWorks
    }, {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  } catch {
    return Response.json({ ok: false, service: "grade7-v2-runtime", code: "RUNTIME_CHECK_FAILED" }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  }
}

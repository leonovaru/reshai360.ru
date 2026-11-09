import { getGrade7Diagnostic, listGrade7Questions, scoreGrade7Answer } from "../_lib/grade7-diagnostic-bank.js";

export async function onRequestGet() {
  try {
    const products = ["7_basic_v2", "7_advanced_v2"];
    const diagnostics = products.map(productKey => {
      const diagnostic = getGrade7Diagnostic(productKey);
      const questions = listGrade7Questions(productKey);
      const idsUnique = new Set(questions.map(question => question && question.questionId)).size === questions.length;
      const allResolved = questions.length > 0 && questions.every(question =>
        question &&
        typeof question.questionId === "string" &&
        question.correctAnswer !== undefined &&
        (question.questionType === "text" || question.questionType === "radio")
      );
      return {
        productKey,
        available: Boolean(diagnostic),
        version: diagnostic ? diagnostic.diagnosticVersion : null,
        questionCount: questions.length,
        idsUnique,
        allResolved
      };
    });

    const scoringChecks = {
      numeric: scoreGrade7Answer(
        { questionType: "text", correctAnswer: "12" },
        { type: "text", value: "12" }
      ) === "CORRECT",
      decimalComma: scoreGrade7Answer(
        { questionType: "text", correctAnswer: "1.5" },
        { type: "text", value: "1,5" }
      ) === "CORRECT",
      fraction: scoreGrade7Answer(
        { questionType: "text", answerMode: "exact_reduced_fraction", correctAnswer: "1/2" },
        { type: "text", value: "1/2" }
      ) === "CORRECT",
      fractionRejectsUnreduced: scoreGrade7Answer(
        { questionType: "text", answerMode: "exact_reduced_fraction", correctAnswer: "1/2" },
        { type: "text", value: "2/4" }
      ) === "INCORRECT",
      radio: scoreGrade7Answer(
        { questionType: "radio", options: ["A", "B"], correctAnswer: 1 },
        { type: "radio", value: "1" }
      ) === "CORRECT"
    };

    const ok = diagnostics.every(item =>
      item.available && item.questionCount > 0 && item.idsUnique && item.allResolved
    ) && Object.values(scoringChecks).every(Boolean);

    return Response.json({
      ok,
      service: "grade7-diagnostic-bank",
      diagnostics,
      scoringChecks
    }, {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    console.error("Grade 7 diagnostic bank health check failed:", error);
    return Response.json({
      ok: false,
      service: "grade7-diagnostic-bank",
      error: "BANK_INITIALIZATION_FAILED"
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}

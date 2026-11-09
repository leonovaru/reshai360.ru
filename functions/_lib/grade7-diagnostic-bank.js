import "../../assets/grade7-diagnostic-data.js";

const BANK = globalThis.GRADE7_DIAGNOSTIC_DATA;

if (!BANK || !BANK.version || !Array.isArray(BANK.fundament) || !Array.isArray(BANK.primenenie)) {
  throw new Error("Grade 7 diagnostic bank is unavailable");
}

const DIAGNOSTICS = Object.freeze({
  "7_basic_v2": Object.freeze({
    diagnosticId: "grade7_fundament",
    diagnosticVersion: BANK.version,
    level: "fundament",
    blocks: BANK.fundament
  }),
  "7_advanced_v2": Object.freeze({
    diagnosticId: "grade7_primenenie",
    diagnosticVersion: BANK.version,
    level: "primenenie",
    blocks: BANK.primenenie
  })
});

export function getGrade7Diagnostic(productKey) {
  return DIAGNOSTICS[String(productKey || "")] || null;
}

export function resolveGrade7Question(productKey, questionId) {
  const diagnostic = getGrade7Diagnostic(productKey);
  if (!diagnostic) return null;

  const match = /^q_(\\d+)_(\\d+)_(\\d+)$/.exec(String(questionId || ""));
  if (!match) return null;

  const blockIndex = Number(match[1]);
  const themeIndex = Number(match[2]);
  const questionIndex = Number(match[3]);
  const block = diagnostic.blocks[blockIndex];
  const theme = block && Array.isArray(block.themes) ? block.themes[themeIndex] : null;
  const question = theme && Array.isArray(theme.questions) ? theme.questions[questionIndex] : null;
  if (!question) return null;

  return {
    diagnosticId: diagnostic.diagnosticId,
    diagnosticVersion: diagnostic.diagnosticVersion,
    level: diagnostic.level,
    questionId: String(questionId),
    blockIndex,
    themeIndex,
    questionIndex,
    blockName: block.block,
    topicId: theme.id,
    topicName: theme.theme,
    questionType: question.type,
    answerMode: question.answerMode || null,
    options: Array.isArray(question.options) ? question.options.slice() : null,
    correctAnswer: question.a
  };
}

export function listGrade7Questions(productKey) {
  const diagnostic = getGrade7Diagnostic(productKey);
  if (!diagnostic) return [];
  const result = [];
  diagnostic.blocks.forEach((block, blockIndex) => {
    block.themes.forEach((theme, themeIndex) => {
      theme.questions.forEach((question, questionIndex) => {
        const questionId = `q_${blockIndex}_${themeIndex}_${questionIndex}`;
        result.push(resolveGrade7Question(productKey, questionId));
      });
    });
  });
  return result;
}

function normalizeAnswerText(value) {
  return String(value == null ? "" : value).trim().replace(/\\s+/g, "").replace(/,/g, ".");
}

function parseNumericAnswer(value) {
  const normalized = normalizeAnswerText(value);
  if (/^[+-]?\\d+(?:\\.\\d+)?$/.test(normalized)) return Number(normalized);
  const fraction = normalized.match(/^([+-]?\\d+)\\/([+-]?\\d+)$/);
  if (fraction && Number(fraction[2]) !== 0) return Number(fraction[1]) / Number(fraction[2]);
  return NaN;
}

function parseReducedFraction(value) {
  const normalized = normalizeAnswerText(value);
  const match = normalized.match(/^([+-]?\\d+)\\/(\\d+)$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return null;
  let a = Math.abs(numerator);
  let b = denominator;
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 1 ? [numerator, denominator] : null;
}

export function scoreGrade7Answer(question, submittedValue) {
  if (!question || !submittedValue || typeof submittedValue !== "object") return "UNASSESSED";

  if (question.questionType === "radio") {
    if (submittedValue.type !== "radio") return "UNASSESSED";
    const selectedIndex = Number(submittedValue.value);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 ||
        !Array.isArray(question.options) || selectedIndex >= question.options.length) {
      return "UNASSESSED";
    }
    return selectedIndex === question.correctAnswer ? "CORRECT" : "INCORRECT";
  }

  if (question.questionType !== "text" || submittedValue.type !== "text") return "UNASSESSED";
  const actual = normalizeAnswerText(submittedValue.value);
  if (!actual) return "UNASSESSED";
  const expected = normalizeAnswerText(question.correctAnswer);

  if (question.answerMode === "exact_reduced_fraction") {
    const actualFraction = parseReducedFraction(actual);
    const expectedFraction = parseReducedFraction(expected);
    return actualFraction && expectedFraction &&
      actualFraction[0] === expectedFraction[0] &&
      actualFraction[1] === expectedFraction[1]
      ? "CORRECT"
      : "INCORRECT";
  }

  const actualNumeric = parseNumericAnswer(actual);
  const expectedNumeric = parseNumericAnswer(expected);
  if (Number.isFinite(actualNumeric) && Number.isFinite(expectedNumeric)) {
    return Math.abs(actualNumeric - expectedNumeric) < 1e-9 ? "CORRECT" : "INCORRECT";
  }
  return actual === expected ? "CORRECT" : "INCORRECT";
}

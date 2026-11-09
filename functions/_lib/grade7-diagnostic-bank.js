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

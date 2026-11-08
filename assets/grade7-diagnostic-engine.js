/* Решай360 · диагностическое ядро 7 класса.
 * Версия 1: прозрачная фиксация наблюдений и осторожная интерпретация.
 * Не заменяет экспертную проверку банка и не делает выводов о причине ошибки.
 */
(function (global) {
  "use strict";

  const VERSION = "7.1.0";
  const COMPETENCIES = {
    M01: "Числовая грамотность",
    M02: "Вычислительные навыки",
    M03: "Работа с математическими выражениями и символами",
    M04: "Работа с математическими зависимостями",
    M05: "Решение задач",
    M06: "Математическое рассуждение",
    M07: "Геометрические представления",
    M08: "Работа с данными"
  };

  const TOPIC_GROUPS = {
    M01: ["N01","N02","N03","N04","F01","F02","Z09","DF01","DF02","DF03","DF04","Z01","Z02","Z03","Z05","P01","P07"],
    M02: ["N05","N06","N07","N10","N11","D01","D04","D05","D06","D07","F03","F04","F05","F06","F07","F08","F09","F10","F11","F12","DF05","DF06","DF07","Z04","Z06","Z07","Z08","A03","A05","A06"],
    M03: ["A01","A02","A04"],
    M04: ["P02","P03","P04","P05","P06","A07"],
    M05: ["T01","T02","T03","T04","T05","T06","T07","T08","T09","T10","P08"],
    M06: ["N08","N09","N12","D02","D03","D08","A06"],
    M07: ["G01","G02","G03","G04","G05","G06","G07","G08","G09","G10","G11","G12","G13","G14","G15","G16","G17","G18","G19","G20"],
    M08: ["S01","S02","S03","S04","S05"]
  };

  const KNOWLEDGE_TOPICS = new Set([
    "N01","N02","N03","D03","D04","F01","F02","DF01","DF03","DF04",
    "P01","P03","P06","P07","Z01","Z02","Z05","A01","A02","A04",
    "G01","G02","G03","G06","G07","G08","G09","G16","G18","G19",
    "S02"
  ]);
  const TRANSFER_TOPICS = new Set([
    "P05","P08","T01","T02","T03","T04","T05","T06","T07","T08","T09","T10",
    "G14","G17","G20","S03","S04","S05"
  ]);

  const TOPIC_COMPETENCY = Object.create(null);
  Object.keys(TOPIC_GROUPS).forEach(competencyId => {
    TOPIC_GROUPS[competencyId].forEach(topicId => {
      if (!TOPIC_COMPETENCY[topicId]) TOPIC_COMPETENCY[topicId] = competencyId;
    });
  });

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getOutcome(question) {
    if (!question || question.userText === "Не введено" || question.userText === "Не выбрано" ||
        question.userText == null || String(question.userText).trim() === "") return "UNANSWERED";
    return question.isCorrect === true ? "CORRECT" : question.isCorrect === false ? "INCORRECT" : "NOT_ASSESSED";
  }

  function getSkillStatus(observations) {
    const groups = new Map();
    observations.forEach(item => {
      if (!groups.has(item.independenceGroup)) groups.set(item.independenceGroup, []);
      groups.get(item.independenceGroup).push(item);
    });
    const independent = Array.from(groups.values()).map(items => {
      const outcomes = new Set(items.map(item => item.outcome));
      const outcome = outcomes.size > 1 && (outcomes.has("CORRECT") || outcomes.has("INCORRECT"))
        ? "CONTRADICTORY"
        : outcomes.has("CORRECT") ? "CORRECT"
        : outcomes.has("INCORRECT") ? "INCORRECT"
        : "UNANSWERED";
      return { outcome };
    });
    const assessed = independent.filter(item => item.outcome === "CORRECT" || item.outcome === "INCORRECT");
    const correct = assessed.filter(item => item.outcome === "CORRECT").length;
    const incorrect = assessed.length - correct;
    const evidenceLevel = assessed.length === 0 ? "E0" : assessed.length === 1 ? "E1" : assessed.length === 2 ? "E2" : "E3";
    let status = "Недостаточно данных";
    let reason = "Нет ответов, которые позволяют оценить это действие.";

    if (assessed.length === 1) {
      reason = assessed[0].outcome === "CORRECT"
        ? "Есть одно успешное выполнение. Устойчивость навыка не проверена."
        : "Зафиксирована одна ошибка. Этого недостаточно, чтобы утверждать, что навык не сформирован.";
    } else if (assessed.length === 2) {
      if (correct === 2) {
        status = "В основном сформировано";
        reason = "Два задания выполнены верно; устойчивость в других форматах и контекстах не подтверждена.";
      } else if (incorrect === 2) {
        status = "Требует развития";
        reason = "Два независимых наблюдения указывают на повторяющееся затруднение; его причина не установлена.";
      } else {
        status = "Формируется";
        reason = "Результаты различаются. Нужна дополнительная проверка в другом формате или контексте.";
      }
    } else if (assessed.length >= 3) {
      if (correct === assessed.length) {
        status = "Сформировано";
        reason = "Все доступные независимые задания выполнены верно. Вывод ограничен представленными заданиями.";
      } else if (incorrect >= 2 && incorrect > correct) {
        status = "Требует развития";
        reason = "Большинство независимых наблюдений содержит ошибки. Причину затруднения нужно проверять отдельно.";
      } else {
        status = "Формируется";
        reason = "Есть как успешные, так и ошибочные выполнения; результат пока нестабилен.";
      }
    }

    return {
      status,
      reason,
      evidenceLevel,
      evidenceCount: assessed.length,
      correctCount: correct,
      incorrectCount: incorrect,
      unansweredCount: observations.filter(item => item.outcome === "UNANSWERED").length,
      contradictory: correct > 0 && incorrect > 0 || independent.some(item => item.outcome === "CONTRADICTORY")
    };
  }

  function evaluate(options) {
    const quizData = options && Array.isArray(options.quizData) ? options.quizData : [];
    const level = options && options.level ? options.level : "unknown";
    const observations = [];
    let questionNumber = 0;

    quizData.forEach((block, blockIndex) => {
      (block.themes || []).forEach((theme, themeIndex) => {
        (theme.questions || []).forEach((question, questionIndex) => {
          questionNumber++;
          const topicId = String(theme.id || ("BLOCK" + blockIndex + "_TOPIC" + themeIndex));
          const outcome = getOutcome(question);
          const competencyId = TOPIC_COMPETENCY[topicId] || "UNMAPPED";
          observations.push({
            taskId: "G7-" + level + "-" + topicId + "-" + (questionIndex + 1),
            topicId,
            topicName: String(theme.theme || topicId),
            blockName: String(block.block || ""),
            questionNumber,
            questionIndex,
            skillId: "G7." + topicId,
            primaryCompetency: competencyId,
            competencyName: COMPETENCIES[competencyId] || "Компетенция не размечена",
            evidenceType: KNOWLEDGE_TOPICS.has(topicId) ? "KNOWLEDGE" : TRANSFER_TOPICS.has(topicId) ? "TRANSFER" : "EXECUTION",
            answerFormat: question.type === "radio" ? "SINGLE_CHOICE" : "NUMERIC_TEXT",
            scoringRule: question.type === "radio" ? "OPTION_EXACT" : "NUMERIC_EQUIVALENCE",
            partialCreditRule: "NOT_AVAILABLE_FINAL_ANSWER_ONLY",
            outcome,
            diagnosticLimit: "Система видит только выбранный или введённый ответ; ход решения и причина ошибки не установлены.",
            independenceGroup: (topicId === "N06" || topicId === "N07") ? ("G7-" + level + "-" + topicId + "-" + (questionIndex + 1)) : ("G7-" + level + "-" + topicId)
          });
        });
      });
    });

    const byTopic = new Map();
    observations.forEach(item => {
      if (!byTopic.has(item.skillId)) byTopic.set(item.skillId, []);
      byTopic.get(item.skillId).push(item);
    });

    const skills = Array.from(byTopic.entries()).map(([skillId, items]) => {
      const result = getSkillStatus(items);
      return {
        skillId,
        topicId: items[0].topicId,
        topicName: items[0].topicName,
        blockName: items[0].blockName,
        competencyId: items[0].primaryCompetency,
        competencyName: items[0].competencyName,
        observations: items,
        ...result
      };
    });

    const competencies = Object.keys(COMPETENCIES).map(competencyId => {
      const related = skills.filter(skill => skill.competencyId === competencyId);
      return {
        competencyId,
        name: COMPETENCIES[competencyId],
        registeredTopics: TOPIC_GROUPS[competencyId].length,
        presentedTopics: related.length,
        topicsWithEvidence: related.filter(skill => skill.evidenceCount > 0).length,
        topicsWithRepeatedEvidence: related.filter(skill => skill.evidenceCount >= 2).length,
        topicsInsufficientData: related.filter(skill => skill.evidenceCount < 2).length
      };
    });

    const answered = observations.filter(item => item.outcome === "CORRECT" || item.outcome === "INCORRECT");
    const correct = answered.filter(item => item.outcome === "CORRECT").length;
    const incorrect = answered.length - correct;
    const unanswered = observations.filter(item => item.outcome === "UNANSWERED").length;
    const statusCounts = skills.reduce((acc, skill) => {
      acc[skill.status] = (acc[skill.status] || 0) + 1;
      return acc;
    }, {});

    return {
      version: VERSION,
      level,
      generatedAt: new Date().toISOString(),
      totalPresented: observations.length,
      evaluated: answered.length,
      correct,
      incorrect,
      unanswered,
      descriptiveAccuracy: answered.length ? correct / answered.length : null,
      evidenceSummary: {
        E0: skills.filter(skill => skill.evidenceLevel === "E0").length,
        E1: skills.filter(skill => skill.evidenceLevel === "E1").length,
        E2: skills.filter(skill => skill.evidenceLevel === "E2").length,
        E3: skills.filter(skill => skill.evidenceLevel === "E3").length
      },
      statusCounts,
      competencies,
      skills,
      observations,
      limitations: [
        "Единичный ответ описывает выполнение конкретного задания, но не подтверждает устойчивое владение навыком.",
        "Принимается только итоговый ответ; частичные решения и ход рассуждения не оцениваются.",
        "Причины ошибок не определяются автоматически.",
        "Процент правильных ответов является описательным показателем и не заменяет профиль навыков."
      ]
    };
  }

  function renderSummary(profile) {
    if (!profile) return "";
    const rows = profile.competencies.map(item => {
      return "<tr><td>" + escapeHtml(item.competencyId + " · " + item.name) + "</td><td>" +
        item.topicsWithEvidence + " из " + item.presentedTopics + "</td><td>" +
        item.topicsWithRepeatedEvidence + "</td></tr>";
    }).join("");
    const counts = profile.statusCounts || {};
    return '<section class="g7-diagnostic-summary" style="margin:24px 0;padding:18px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;color:#1e293b;">' +
      '<h3 style="margin:0 0 8px;color:#1b365d;font-size:1.15em;">Диагностическая интерпретация</h3>' +
      '<p style="margin:0 0 10px;line-height:1.5;">Проверено заданий: <b>' + profile.totalPresented +
      '</b>; оценено ответов: <b>' + profile.evaluated + '</b>; без ответа: <b>' + profile.unanswered + '</b>.</p>' +
      '<p style="margin:0 0 10px;line-height:1.5;">Навыки с единичным наблюдением: <b>' + (profile.evidenceSummary.E1 || 0) +
      '</b>; с повторными наблюдениями: <b>' + ((profile.evidenceSummary.E2 || 0) + (profile.evidenceSummary.E3 || 0)) +
      '</b>; без оценённых наблюдений: <b>' + (profile.evidenceSummary.E0 || 0) + '</b>.</p>' +
      '<p style="margin:0 0 12px;line-height:1.5;color:#475569;">Единичный ответ не подтверждает устойчивое владение навыком. Процент правильных ответов — описательный показатель, а не уровень сформированности.</p>' +
      '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:.92em;"><thead><tr><th style="text-align:left;padding:7px;border-bottom:1px solid #cbd5e1;">Компетенция</th><th style="text-align:left;padding:7px;border-bottom:1px solid #cbd5e1;">Темы с данными</th><th style="text-align:left;padding:7px;border-bottom:1px solid #cbd5e1;">Повторные наблюдения</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      '<details style="margin-top:12px;"><summary style="cursor:pointer;font-weight:700;">Ограничения интерпретации</summary><ul style="margin:8px 0 0;padding-left:20px;">' +
      profile.limitations.map(item => "<li>" + escapeHtml(item) + "</li>").join("") +
      '</ul></details></section>';
  }

  global.Reshai360Grade7Diagnostic = {
    version: VERSION,
    evaluate,
    renderSummary
  };
})(window);

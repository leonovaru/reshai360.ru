/* Единый генератор PDF-отчётов Решай360.
 * Источник данных: структура quizData + сохранённый снимок диагностики.
 * Генерация не читает поля ввода и не зависит от ширины экрана.
 */
(function (global) {
  "use strict";

  const VERSION = 24;
  const PAGE_WIDTH = 794;
  const PAGE_HEIGHT = 1122;
  const PAGE_CONTENT_HEIGHT = 1030;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeAnswer(value) {
    return String(value == null ? "" : value).trim().replace(/\s+/g, "").replace(/,/g, ".");
  }

  function parseNumeric(value) {
    const normalized = normalizeAnswer(value);
    if (/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
    const fraction = normalized.match(/^([+-]?\d+)\/([+-]?\d+)$/);
    if (fraction && Number(fraction[2]) !== 0) return Number(fraction[1]) / Number(fraction[2]);
    return NaN;
  }

  function isExactReducedFractionAnswer(value, expected) {
    const parseReduced = input => {
      const match = normalizeAnswer(input).match(/^([+-]?\d+)\/(\d+)$/);
      if (!match) return null;
      const numerator = Number(match[1]);
      const denominator = Number(match[2]);
      if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return null;
      let a = Math.abs(numerator), b = denominator;
      while (b) { const remainder = a % b; a = b; b = remainder; }
      return a === 1 ? [numerator, denominator] : null;
    };
    const actual = parseReduced(value);
    const target = parseReduced(expected);
    return !!actual && !!target && actual[0] === target[0] && actual[1] === target[1];
  }

  function evaluateQuestion(question, questionId, answerSnapshot, statsSnapshot, formatMath) {
    const savedAnswer = answerSnapshot && answerSnapshot.answers && answerSnapshot.answers[questionId];
    const stat = statsSnapshot && statsSnapshot[questionId] || {};
    let rawAnswer = "";
    let finalAnswer = "";
    let correctAnswer = "";
    let isSkipped = false;
    let isCorrect = false;

    if (question.type === "radio") {
      const selectedIndex = savedAnswer && savedAnswer.type === "radio" ? Number(savedAnswer.value) : NaN;
      const hasAnswer = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < (question.options || []).length;
      rawAnswer = hasAnswer ? String(selectedIndex) : "";
      finalAnswer = hasAnswer ? String(question.options[selectedIndex]) : "Не выбрано";
      correctAnswer = String(question.options[Number(question.a)] == null ? "" : question.options[Number(question.a)]);
      isSkipped = !hasAnswer;
      isCorrect = hasAnswer && selectedIndex === Number(question.a);
    } else {
      rawAnswer = savedAnswer && savedAnswer.type === "text" ? String(savedAnswer.value || "").trim() : "";
      finalAnswer = rawAnswer ? rawAnswer.replace(/\./g, ",") : "Не введено";
      correctAnswer = String(question.a == null ? "" : question.a).replace(/\./g, ",");
      isSkipped = !rawAnswer;
      if (rawAnswer) {
        if (question.answerMode === "exact_reduced_fraction") {
          isCorrect = isExactReducedFractionAnswer(rawAnswer, question.a);
        } else {
          const userNumber = parseNumeric(rawAnswer);
          const expectedNumber = parseNumeric(question.a);
          isCorrect = Number.isFinite(userNumber) && Number.isFinite(expectedNumber)
            ? Math.abs(userNumber - expectedNumber) < 1e-9
            : normalizeAnswer(rawAnswer) === normalizeAnswer(question.a);
        }
      }
    }

    const history = Array.isArray(stat.attemptsHistory) ? stat.attemptsHistory.map(String) : [];
    const checkCount = Math.max(Number(stat.checkCount) || 0, history.length);
    const distinctRadioAnswers = new Set(history.filter(item => item && item !== "Не выбрано"));
    if (question.type === "radio" && finalAnswer !== "Не выбрано") distinctRadioAnswers.add(finalAnswer);
    const guessedByBruteForce = question.type === "radio" && (question.options || []).length > 0 && distinctRadioAnswers.size >= question.options.length;

    let statusClass = "incorrect";
    let badgeClass = "badge-err";
    let badgeText = "Ошибка ⚠️";
    if (isCorrect && !guessedByBruteForce) {
      statusClass = "correct";
      badgeClass = "badge-ok";
      badgeText = "Верно ✅";
    } else if (isCorrect && guessedByBruteForce) {
      badgeText = "Перебор ⚠️";
    } else if (isSkipped) {
      statusClass = "skipped";
      badgeClass = "badge-skip";
      badgeText = "Не решено ❌";
    }

    const attemptsText = history.length ? history.join(" ➔ ") : "Проверок ещё не было";
    return {
      finalAnswer,
      correctAnswer,
      isSkipped,
      isCorrect,
      guessedByBruteForce,
      checkCount,
      attemptsText,
      statusClass,
      badgeClass,
      badgeText
    };
  }

  function makeQuestionCard(question, number, result, formatMath, grade) {
    const questionHtml = typeof formatMath === "function"
      ? formatMath(question.q)
      : escapeHtml(question.q);
    const correctHtml = typeof formatMath === "function"
      ? formatMath(result.correctAnswer)
      : escapeHtml(result.correctAnswer);
    const answerDetails = grade === "7"
      ? "<b>Ответ участника:</b> " + escapeHtml(result.finalAnswer) + "<br>"
      : "<b>Введенных ответов:</b> " + result.checkCount + " | <b>Ответы:</b> " +
        (result.checkCount ? escapeHtml(result.attemptsText) : (result.isSkipped ? (question.type === "radio" ? "Не выбрано" : "Не введено") : "Проверок ещё не было")) + "<br>";
    return `
      <div class="pdf-card ${result.statusClass}">
        <div class="pdf-q">${number}. ${questionHtml}</div>
        <div class="pdf-card-footer">
          <div class="pdf-ans">
            ${answerDetails}
            <b>Правильный ответ:</b> ${correctHtml}
          </div>
          <span class="badge ${result.badgeClass}">${result.badgeText}</span>
        </div>
      </div>`;
  }

  async function typeset(element) {
    if (!global.MathJax) return;
    try {
      if (global.MathJax.startup && global.MathJax.startup.promise) await global.MathJax.startup.promise;
      if (typeof global.MathJax.typesetPromise === "function") await global.MathJax.typesetPromise([element]);
    } catch (error) {
      console.warn("Не удалось отобразить формулы в PDF:", error);
    }
  }

  function makeCompetencyPage(profile) {
    const rows = (profile.competencies || []).map(item =>
      "<tr><td style='padding:7px;border-bottom:1px solid #e2e8f0;'>" + escapeHtml(item.competencyId + " · " + item.name) +
      "</td><td style='padding:7px;border-bottom:1px solid #e2e8f0;text-align:center;'>" +
      item.unitsWithEvidence + " / " + item.presentedUnits + "</td><td style='padding:7px;border-bottom:1px solid #e2e8f0;text-align:center;'>" +
      item.unitsWithRepeatedEvidence + "</td></tr>"
    ).join("");
    const repeated = (profile.skills || [])
      .filter(skill => skill.evidenceCount >= 2 || skill.partialCount > 0 || skill.incompleteCount > 0)
      .sort((a, b) => {
        const priority = skill => skill.errorHypothesisLevel === "H2" ? 0 :
          skill.partialCount > 0 ? 1 : skill.incompleteCount > 0 ? 2 :
          skill.errorHypothesisLevel === "H1" ? 3 : 4;
        return priority(a) - priority(b);
      }).slice(0, 10);
    const repeatedHtml = repeated.length
      ? "<ul style='font-size:.86em;line-height:1.4;margin:0;padding-left:20px;'>" +
        repeated.map(skill =>
          "<li style='margin:5px 0;'><b>" + escapeHtml(skill.skillLabel || skill.topicName) + ":</b> " + escapeHtml(skill.status) +
          (skill.partialCount > 0 ? " (частичный результат: " + skill.correctCount + " верно, " + skill.incorrectCount + " с ошибкой)." :
          skill.incompleteCount > 0 ? " (неполное выполнение: " + skill.unansweredCount + " ответов без ответа)." :
          skill.evidenceCount > 0 ? " (верно: " + skill.correctCount + ", с ошибкой: " + skill.incorrectCount + ")." : ".") +
          " " + escapeHtml(skill.reason) + "</li>"
        ).join("") + "</ul>"
      : "<p style='font-size:.86em;line-height:1.4;margin:0;'>Пока недостаточно повторных наблюдений для устойчивых выводов по отдельным навыкам.</p>";
    const limitations = (profile.limitations || []).map(item => "<li>" + escapeHtml(item) + "</li>").join("");
    return "<div class='pdf-first-page-content'>" +
      "<h1 class='pdf-header-title'>Карта компетенций и свидетельств</h1>" +
      "<p style='font-size:.82em;color:#64748b;margin:0 0 12px;'>Методика " + escapeHtml(profile.version || "") +
      " · банк заданий " + escapeHtml(profile.bankVersion || "") + " · предварительная разметка</p>" +
      "<div class='pdf-analytics-title'>Покрытие компетенций</div>" +
      "<p style='font-size:.82em;line-height:1.4;margin:0 0 8px;'>В таблице показано, по скольким диагностическим единицам получены оценённые ответы. В разделённых темах разные действия считаются отдельно. Это показатель покрытия, а не уровень сформированности компетенции.</p>" +
      "<table style='width:100%;border-collapse:collapse;font-size:.82em;margin-bottom:16px;'><thead><tr>" +
      "<th style='text-align:left;padding:7px;border-bottom:1px solid #cbd5e1;'>Компетенция</th>" +
      "<th style='padding:7px;border-bottom:1px solid #cbd5e1;'>Диагностические единицы с данными</th>" +
      "<th style='padding:7px;border-bottom:1px solid #cbd5e1;'>Единицы с повторными наблюдениями</th></tr></thead><tbody>" + rows + "</tbody></table>" +
      "<div class='pdf-analytics-title'>Навыки с повторными свидетельствами или неполным результатом</div>" + repeatedHtml +
      "<div class='pdf-analytics-title' style='margin-top:16px;'>Ограничения интерпретации</div>" +
      "<ul style='font-size:.8em;line-height:1.35;margin:0;padding-left:20px;'>" + limitations + "</ul>" +
      "</div>";
  }

  function makeFirstPage(model) {
    const { grade, levelLabel, studentName, dateText, score, total, evaluated, unanswered, blockRows, repeatTopics, studyTopics, diagnosticProfile } = model;
    const accuracyDenominator = grade === "7" ? evaluated : total;
    const percent = accuracyDenominator ? Math.round(score / accuracyDenominator * 100) : 0;
    const scoreLabel = grade === "7" ? "Доля правильных ответов среди оценённых" : "Итоговый результат";
    const scoreText = grade === "7"
      ? (evaluated > 0 ? score + " из " + evaluated + " (" + percent + "%)" : "Нет оценённых ответов")
      : score + " из " + total + " (" + percent + "%)";
    const topicLimit = 12;
    const repeatVisible = repeatTopics.slice(0, topicLimit);
    const studyVisible = studyTopics.slice(0, topicLimit);
    const repeatHtml = repeatTopics.length
      ? "<ol>" + repeatVisible.map(topic => "<li>" + escapeHtml(topic) + "</li>").join("") + "</ol>" + (repeatTopics.length > topicLimit ? '<p style="margin:4px 0 0;">И ещё ' + (repeatTopics.length - topicLimit) + ' тем — см. задания в подробной части отчёта.</p>' : "")
      : (grade === "7"
          ? (diagnosticProfile && diagnosticProfile.evaluated === 0
              ? '<p style="margin:0;">Нет оценённых ответов.</p>'
              : '<p style="margin:0;">Повторяющихся затруднений по имеющимся наблюдениям не выявлено. Единичные ошибки см. в подробных заданиях.</p>')
          : '<p style="margin:0;">Ошибок в решённых заданиях нет.</p>');
    const studyHtml = studyTopics.length
      ? "<ol>" + studyVisible.map(topic => "<li>" + escapeHtml(topic) + "</li>").join("") + "</ol>" + (studyTopics.length > topicLimit ? '<p style="margin:4px 0 0;">И ещё ' + (studyTopics.length - topicLimit) + ' тем — см. задания в подробной части отчёта.</p>' : "")
      : '<p style="margin:0;">Пропущенных заданий нет.</p>';
    const evidence = diagnosticProfile && diagnosticProfile.evidenceSummary || {};
    const diagnosticSummaryHtml = grade === "7" && diagnosticProfile
      ? "<div class='pdf-analytics-title'>Диагностическая интерпретация</div>" +
        "<p style='font-size:.78em;line-height:1.35;margin:0 0 6px;'>Единичное выполнение описывает ответ на конкретное задание, но не подтверждает устойчивое владение навыком. Процент правильных ответов не является уровнем сформированности. Разметка навыков и компетенций предварительная и требует экспертной проверки.</p>" +
        "<p style='font-size:.78em;line-height:1.35;margin:0 0 6px;'>Диагностические единицы с единичным наблюдением: <b>" + (evidence.E1 || 0) +
        "</b>; повторные наблюдения: <b>" + ((evidence.E2 || 0) + (evidence.E3 || 0)) +
        "</b>; без оценённых наблюдений: <b>" + (evidence.E0 || 0) + "</b>.</p>" +
        "<p style='font-size:.78em;line-height:1.35;margin:0 0 6px;'>Повторяющиеся затруднения (H2): <b>" + ((diagnosticProfile.errorHypothesisSummary || {}).H2 || 0) +
         "</b>; диагностические единицы с частичным результатом: <b>" + (diagnosticProfile.partialSkillCount || 0) +
        "</b>; с неполным выполнением: <b>" + (diagnosticProfile.skills || []).filter(skill => skill.incompleteCount > 0).length + "</b>. Подробная карта компетенций и повторных наблюдений приведена на следующей странице.</p>"
      : "";
    const blockHeading = grade === "7"
      ? "Доля правильных ответов по блокам (описательный показатель)"
      : "Результат диагностики";
    const repeatHeading = grade === "7"
      ? "Темы с повторяющимися затруднениями:"
      : "⚠️ Темы для повторения (ошибки / перебор):";
    const studyHeading = grade === "7"
      ? "Темы с пропущенными заданиями (недостаточно данных):"
      : "📌 Темы для изучения (не решено):";
    return `
      <div class="pdf-first-page-content">
        <h1 class="pdf-header-title">Диагностическая карта знаний</h1>
        <div class="pdf-score-card">
          <div class="pdf-student-info">
            ${escapeHtml(grade)} класс · ${escapeHtml(levelLabel || "")}<br>
            <strong>Ученик:</strong> ${escapeHtml(studentName)}<br>
            Дата прохождения: ${escapeHtml(dateText)}
          </div>
          <div class="pdf-score-right">
            <div class="pdf-score-label">${scoreLabel}</div>
            <div class="pdf-score-main">${scoreText}</div>
            ${grade === "7" ? "<div class='pdf-score-label'>Всего заданий: " + total + "; без ответа: " + unanswered + "</div>" : ""}
          </div>
        </div>
        <div class="pdf-analytics-title">${blockHeading}</div>
        <div>${blockRows}</div>
        ${diagnosticSummaryHtml}
        <div class="pdf-topics-container">
          <div class="pdf-topics-box repeat">
            <h4>${repeatHeading}</h4>${repeatHtml}
          </div>
          <div class="pdf-topics-box study">
            <h4>${studyHeading}</h4>${studyHtml}
          </div>
        </div>
      </div>`;
  }

  async function buildPages(model) {
    const { firstPageHtml, cards, formatMath } = model;
    const measure = document.createElement("div");
    measure.style.cssText = "position:fixed;left:-12000px;top:0;width:714px;padding:0 0 1px;box-sizing:border-box;visibility:hidden;font:15px Arial,sans-serif;";
    document.body.appendChild(measure);

    const detailPages = [];
    let current = [];
    for (const card of cards) {
      // Сначала очищаем реестр MathJax для старого DOM, и только затем
      // заменяем содержимое измерительного контейнера.
      if (global.MathJax && global.MathJax.typesetClear) {
        try { global.MathJax.typesetClear([measure]); } catch (_) {}
      }
      measure.innerHTML = '<h3 class="detail-section-title">Результаты выполнения заданий</h3>' + current.concat(card).join("");
      await typeset(measure);
      const height = Math.max(measure.scrollHeight, measure.offsetHeight);
      if (height > PAGE_CONTENT_HEIGHT && current.length) {
        detailPages.push(current);
        current = [card];
      } else {
        current.push(card);
      }
    }
    if (current.length) detailPages.push(current);
    if (global.MathJax && global.MathJax.typesetClear) {
      try { global.MathJax.typesetClear([measure]); } catch (_) {}
    }
    measure.remove();

    const hasCompetencyPage = grade === "7" && !!diagnosticProfile;
    const totalPages = 1 + (hasCompetencyPage ? 1 : 0) + detailPages.length;
    let html = '<div class="pdf-page">' + firstPageHtml +
      '<div class="page-footer">Диагностический отчет | Страница 1 из ' + totalPages + '</div></div>';
    if (hasCompetencyPage) {
      html += '<div class="pdf-page">' + makeCompetencyPage(diagnosticProfile) +
        '<div class="page-footer">Диагностический отчет | Страница 2 из ' + totalPages + '</div></div>';
    }
    let index = 0;
    detailPages.forEach((pageCards, pageIndex) => {
      const start = index + 1;
      const end = index + pageCards.length;
      index += pageCards.length;
      const pageNumber = pageIndex + (hasCompetencyPage ? 3 : 2);
      html += '<div class="pdf-page"><h3 class="detail-section-title">Результаты выполнения заданий (Задания ' +
        start + "–" + end + ")</h3>" + pageCards.join("") +
        '<div class="page-footer">Диагностический отчет | Страница ' + pageNumber + " из " + totalPages + "</div></div>";
    });
    return html;
  }

  async function renderPdfBlob(container) {
    if (!global.jspdf || !global.jspdf.jsPDF || typeof global.html2canvas !== "function") {
      throw new Error("Библиотеки формирования PDF не загрузились. Обновите страницу и попробуйте ещё раз.");
    }
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pdf = new global.jspdf.jsPDF({ orientation: "p", unit: "mm", format: "a4", compress: true });
    const pages = Array.from(container.querySelectorAll(".pdf-page"));
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const content = page.querySelector(".pdf-first-page-content");
      if (content) {
        content.style.transform = "none";
        content.style.width = "100%";
        const available = page.clientHeight - 70;
        const natural = content.scrollHeight;
        if (natural > available) {
          const scale = Math.min(1, available / natural);
          content.style.transform = "scale(" + scale + ")";
          content.style.width = (100 / scale) + "%";
        }
      }
      if (i) pdf.addPage();
      const canvas = await global.html2canvas(page, {
        scale: 2,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        useCORS: true,
        logging: false,
        backgroundColor: "#ffffff",
        // Всегда рендерим в фиксированном «компьютерном» viewport A4,
        // независимо от реального экрана устройства.
        windowWidth: PAGE_WIDTH,
        windowHeight: PAGE_HEIGHT,
        scrollX: 0,
        scrollY: 0,
        onclone: clonedDocument => {
          // Изолируем PDF от мобильного viewport и автоматического увеличения текста
          // браузерами iOS/Android. Макет всегда остаётся 794 × 1122 px.
          clonedDocument.documentElement.style.cssText += ";width:794px!important;min-width:794px!important;max-width:794px!important;-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important;";
          clonedDocument.body.style.cssText += ";width:794px!important;min-width:794px!important;max-width:794px!important;-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important;";
          const exportContainer = clonedDocument.getElementById("pdf-export-container");
          if (exportContainer) {
            exportContainer.style.cssText += ";position:absolute!important;left:0!important;top:0!important;width:794px!important;min-width:794px!important;max-width:794px!important;opacity:1!important;visibility:visible!important;z-index:auto!important;transform:none!important;";
          }
          const clonedPages = clonedDocument.querySelectorAll("#result-pdf .pdf-page");
          const clonedPage = clonedPages[i];
          if (!clonedPage) return;
          clonedPage.style.cssText += ";width:794px!important;min-width:794px!important;max-width:794px!important;height:1122px!important;min-height:1122px!important;max-height:1122px!important;overflow:hidden!important;box-sizing:border-box!important;background:#fff!important;font-family:Arial,sans-serif!important;font-size:15px!important;line-height:normal;-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important;opacity:1!important;visibility:visible!important;transform:none!important;";
          clonedPage.querySelectorAll(".pdf-q").forEach(node => {
            node.style.textAlign = "left";
            node.style.overflowWrap = "normal";
            node.style.wordBreak = "normal";
          });
          clonedPage.querySelectorAll("mjx-container").forEach(node => {
            node.style.display = "inline-block";
            node.style.fontSize = "100%";
            node.style.maxWidth = "100%";
            node.style.overflow = "visible";
            node.style.verticalAlign = "middle";
          });
          clonedPage.querySelectorAll("mjx-container svg").forEach(svg => {
            svg.style.fontSize = "100%";
            svg.style.maxWidth = "100%";
            svg.style.height = "auto";
            svg.style.overflow = "visible";
          });
        }
      });
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, 210, 297);
    }
    return pdf.output("blob");
  }

  async function generate(options) {
    const { quizData, snapshot, studentName, formatMath, resultContainer, diagnosticProfile: suppliedDiagnosticProfile } = options || {};
    if (!Array.isArray(quizData) || !resultContainer) throw new Error("Недостаточно данных для формирования отчёта.");
    const answersSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    const statsSnapshot = answersSnapshot.stats || {};
    const diagnosticProfile = suppliedDiagnosticProfile || answersSnapshot.diagnosticProfile || null;
    const match = String(global.location && global.location.pathname || "").match(/test_(\d+)_(basic|advanced)/i);
    const grade = match ? match[1] : "";
    const level = match ? match[2] : "basic";
    const levelLabel = grade === "7" ? (level === "basic" ? "Фундамент" : "Применение") : (level === "basic" ? "Лёгкий старт" : "Полная диагностика");
    const dateText = new Date().toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
    let score = 0;
    let total = 0;
    let evaluated = 0;
    let blockRows = "";
    const repeatTopics = new Set();
    const studyTopics = new Set();
    const cards = [];
    let questionNumber = 0;

    quizData.forEach((block, blockIndex) => {
      let blockCorrect = 0;
      let blockTotal = 0;
      let blockEvaluated = 0;
      (block.themes || []).forEach((theme, themeIndex) => {
        const themeName = String(theme.theme || "").replace(/^\d+\.\s*/, "");
        (theme.questions || []).forEach((question, questionIndex) => {
          questionNumber++;
          const id = "q_" + blockIndex + "_" + themeIndex + "_" + questionIndex;
          const result = evaluateQuestion(question, id, answersSnapshot, statsSnapshot, formatMath);
          if (result.isCorrect) blockCorrect++;
          blockTotal++;
          if (!result.isSkipped) blockEvaluated++;
          if (result.isSkipped) studyTopics.add(themeName);
          else if (!result.isCorrect || result.guessedByBruteForce) repeatTopics.add(themeName);
          cards.push(makeQuestionCard(question, questionNumber, result, formatMath, grade));
        });
      });
      const blockDenominator = grade === "7" ? blockEvaluated : blockTotal;
      const blockPercent = blockDenominator ? Math.round(blockCorrect / blockDenominator * 100) : null;
      const fillClass = blockPercent === null ? "" : (blockPercent < 50 ? "bg-red" : (blockPercent < 70 ? "bg-yellow" : "bg-green"));
      const blockValue = blockPercent === null
        ? "нет данных"
        : (grade === "7" ? blockCorrect + " / " + blockEvaluated + " (" + blockPercent + "%)" : blockPercent + "%");
      blockRows += '<div class="pdf-progress-row"><div class="pdf-progress-header"><span>' +
        escapeHtml(block.block) + '</span><span>' + blockValue + '</span></div><div class="pdf-progress-track">' +
        '<div class="pdf-progress-fill ' + fillClass + '" style="width:' + (blockPercent === null ? 0 : blockPercent) + '%"></div></div></div>';
      score += blockCorrect;
      total += blockTotal;
      evaluated += blockEvaluated;
    });

    if (grade === "7") {
      repeatTopics.clear();
      (diagnosticProfile && diagnosticProfile.skills || []).forEach(skill => {
        if (skill.status === "Требует развития") repeatTopics.add(skill.topicName);
      });
    }

    const model = {
      grade,
      level,
      levelLabel,
      studentName: studentName || "Ученик",
      dateText,
      score,
      total,
      evaluated,
      unanswered: total - evaluated,
      blockRows,
      repeatTopics: Array.from(repeatTopics),
      studyTopics: Array.from(studyTopics),
      diagnosticProfile,
      cards,
      formatMath
    };
    const firstPageHtml = makeFirstPage(model);
    resultContainer.innerHTML = await buildPages({ firstPageHtml, cards, formatMath });
    if (global.MathJax && global.MathJax.typesetClear) {
      try { global.MathJax.typesetClear([resultContainer]); } catch (_) {}
    }
    await typeset(resultContainer);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return renderPdfBlob(resultContainer);
  }

  global.Reshai360ReportGenerator = { version: VERSION, generate };
})(window);

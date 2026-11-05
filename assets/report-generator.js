/* Единый генератор PDF-отчётов Решай360.
 * Источник данных: структура quizData + сохранённый снимок диагностики.
 * Генерация не читает поля ввода и не зависит от ширины экрана.
 */
(function (global) {
  "use strict";

  const VERSION = 3;
  const PAGE_WIDTH = 794;
  const PAGE_HEIGHT = 1122;
  const PAGE_CONTENT_HEIGHT = 1000;

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
        const userNumber = parseNumeric(rawAnswer);
        const expectedNumber = parseNumeric(question.a);
        isCorrect = Number.isFinite(userNumber) && Number.isFinite(expectedNumber)
          ? Math.abs(userNumber - expectedNumber) < 1e-9
          : normalizeAnswer(rawAnswer) === normalizeAnswer(question.a);
      }
    }

    const history = Array.isArray(stat.attemptsHistory) ? stat.attemptsHistory.map(String) : [];
    const checkCount = Math.max(Number(stat.checkCount) || 0, history.length);
    const distinctRadioAnswers = new Set(history.filter(item => item && item !== "Не выбрано"));
    if (question.type === "radio" && finalAnswer !== "Не выбрано") distinctRadioAnswers.add(finalAnswer);
    const guessedByBruteForce = question.type === "radio" && distinctRadioAnswers.size > 1;

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
      isCorrect: isCorrect && !guessedByBruteForce,
      guessedByBruteForce,
      checkCount,
      attemptsText,
      statusClass,
      badgeClass,
      badgeText
    };
  }

  function makeQuestionCard(question, number, result, formatMath) {
    const questionHtml = typeof formatMath === "function"
      ? formatMath(question.q)
      : escapeHtml(question.q);
    const correctHtml = typeof formatMath === "function"
      ? formatMath(result.correctAnswer)
      : escapeHtml(result.correctAnswer);
    return `
      <div class="pdf-card ${result.statusClass}">
        <div class="pdf-q">${number}. ${questionHtml}</div>
        <div class="pdf-card-footer">
          <div class="pdf-ans">
            <b>Итоговый ответ:</b> ${escapeHtml(result.finalAnswer)}<br>
            <b>Введенных ответов:</b> ${result.checkCount}${result.checkCount ? " | <b>Ответы:</b> " + escapeHtml(result.attemptsText) : ""}<br>
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

  function makeFirstPage(model) {
    const { grade, studentName, dateText, score, total, blockRows, repeatTopics, studyTopics } = model;
    const percent = total ? Math.round(score / total * 100) : 0;
    const repeatHtml = repeatTopics.length
      ? "<ol>" + repeatTopics.map(topic => "<li>" + escapeHtml(topic) + "</li>").join("") + "</ol>"
      : '<p style="margin:0;">Ошибок в решённых заданиях нет.</p>';
    const studyHtml = studyTopics.length
      ? "<ol>" + studyTopics.map(topic => "<li>" + escapeHtml(topic) + "</li>").join("") + "</ol>"
      : '<p style="margin:0;">Пропущенных заданий нет.</p>';
    return `
      <div class="pdf-first-page-content">
        <h1 class="pdf-header-title">Диагностическая карта знаний</h1>
        <div class="pdf-score-card">
          <div class="pdf-student-info">
            ${escapeHtml(grade)} класс<br>
            <strong>Ученик:</strong> ${escapeHtml(studentName)}<br>
            Дата прохождения: ${escapeHtml(dateText)}
          </div>
          <div class="pdf-score-right">
            <div class="pdf-score-label">Итоговый результат</div>
            <div class="pdf-score-main">${score} из ${total} (${percent}%)</div>
          </div>
        </div>
        <div class="pdf-analytics-title">Результат диагностики</div>
        <div>${blockRows}</div>
        <div class="pdf-topics-container">
          <div class="pdf-topics-box repeat">
            <h4>⚠️ Темы для повторения (ошибки / перебор):</h4>${repeatHtml}
          </div>
          <div class="pdf-topics-box study">
            <h4>📌 Темы для изучения (не решено):</h4>${studyHtml}
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
      measure.innerHTML = '<h3 class="detail-section-title">Результаты выполнения заданий</h3>' + current.concat(card).join("");
      if (global.MathJax && global.MathJax.typesetClear) {
        try { global.MathJax.typesetClear([measure]); } catch (_) {}
      }
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

    const totalPages = 1 + detailPages.length;
    let html = '<div class="pdf-page">' + firstPageHtml +
      '<div class="page-footer">Диагностический отчет | Страница 1 из ' + totalPages + '</div></div>';
    let index = 0;
    detailPages.forEach((pageCards, pageIndex) => {
      const start = index + 1;
      const end = index + pageCards.length;
      index += pageCards.length;
      html += '<div class="pdf-page"><h3 class="detail-section-title">Результаты выполнения заданий (Задания ' +
        start + "–" + end + ")</h3>" + pageCards.join("") +
        '<div class="page-footer">Диагностический отчет | Страница ' + (pageIndex + 2) + " из " + totalPages + "</div></div>";
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
        useCORS: true,
        logging: false,
        backgroundColor: "#ffffff",
        windowWidth: PAGE_WIDTH,
        windowHeight: PAGE_HEIGHT,
        scrollX: 0,
        scrollY: 0,
        onclone: clonedDocument => {
          const exportContainer = clonedDocument.getElementById("pdf-export-container");
          if (exportContainer) {
            exportContainer.style.opacity = "1";
            exportContainer.style.visibility = "visible";
            exportContainer.style.zIndex = "auto";
          }
          const clonedPages = clonedDocument.querySelectorAll("#result-pdf .pdf-page");
          const clonedPage = clonedPages[i];
          if (!clonedPage) return;
          clonedPage.style.cssText += ";width:794px;height:1122px;min-height:1122px;max-height:1122px;max-width:none;overflow:hidden;box-sizing:border-box;background:#fff;opacity:1;visibility:visible;";
          clonedPage.querySelectorAll("mjx-container").forEach(node => {
            node.style.maxWidth = "100%";
            node.style.overflow = "visible";
          });
          clonedPage.querySelectorAll("mjx-container svg").forEach(svg => {
            svg.style.maxWidth = "none";
            svg.style.overflow = "visible";
          });
        }
      });
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, 210, 297);
    }
    return pdf.output("blob");
  }

  async function generate(options) {
    const { quizData, snapshot, studentName, formatMath, resultContainer } = options || {};
    if (!Array.isArray(quizData) || !resultContainer) throw new Error("Недостаточно данных для формирования отчёта.");
    const answersSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    const statsSnapshot = answersSnapshot.stats || {};
    const match = String(global.location && global.location.pathname || "").match(/test_(\d+)_(basic|advanced)/i);
    const grade = match ? match[1] : "";
    const level = match ? match[2] : "basic";
    const dateText = new Date().toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
    let score = 0;
    let total = 0;
    let blockRows = "";
    const repeatTopics = new Set();
    const studyTopics = new Set();
    const cards = [];
    let questionNumber = 0;

    quizData.forEach((block, blockIndex) => {
      let blockCorrect = 0;
      let blockTotal = 0;
      (block.themes || []).forEach((theme, themeIndex) => {
        const themeName = String(theme.theme || "").replace(/^\d+\.\s*/, "");
        (theme.questions || []).forEach((question, questionIndex) => {
          questionNumber++;
          const id = "q_" + blockIndex + "_" + themeIndex + "_" + questionIndex;
          const result = evaluateQuestion(question, id, answersSnapshot, statsSnapshot, formatMath);
          if (result.isCorrect) blockCorrect++;
          blockTotal++;
          if (result.isSkipped) studyTopics.add(themeName);
          else if (!result.isCorrect || result.guessedByBruteForce) repeatTopics.add(themeName);
          cards.push(makeQuestionCard(question, questionNumber, result, formatMath));
        });
      });
      const blockPercent = blockTotal ? Math.round(blockCorrect / blockTotal * 100) : 0;
      const fillClass = blockPercent < 50 ? "bg-red" : (blockPercent < 70 ? "bg-yellow" : "bg-green");
      blockRows += '<div class="pdf-progress-row"><div class="pdf-progress-header"><span>' +
        escapeHtml(block.block) + '</span><span>' + blockPercent + '%</span></div><div class="pdf-progress-track">' +
        '<div class="pdf-progress-fill ' + fillClass + '" style="width:' + blockPercent + '%"></div></div></div>';
      score += blockCorrect;
      total += blockTotal;
    });

    const model = {
      grade,
      level,
      studentName: studentName || "Ученик",
      dateText,
      score,
      total,
      blockRows,
      repeatTopics: Array.from(repeatTopics),
      studyTopics: Array.from(studyTopics),
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

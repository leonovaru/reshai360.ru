function doPost(e) {
  try {
    const properties = PropertiesService.getScriptProperties();
    const expectedSecret = properties.getProperty("WEBHOOK_SECRET");
    const spreadsheetId = properties.getProperty("SPREADSHEET_ID");

    if (!expectedSecret || !spreadsheetId) {
      return json_({ success: false, error: "Script properties are not configured" });
    }

    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (!payload.secret || payload.secret !== expectedSecret) {
      return json_({ success: false, error: "Unauthorized" });
    }

    const token = String(payload.orderToken || "").trim();
    const order = payload.order;
    if (!token || !order || typeof order !== "object") {
      return json_({ success: false, error: "Invalid order payload" });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      spreadsheet.setSpreadsheetTimeZone("Europe/Moscow");
      const sheet = spreadsheet.getSheetByName("Заказы") || spreadsheet.insertSheet("Заказы");
      const legacyHeaders = [
        "Дата создания", "Токен заказа", "Имя", "Email", "Ключ продукта", "Диагностика",
        "Стоимость, ₽", "Цена до скидки, ₽", "Скидка, ₽", "Скидка, %",
        "Промокод", "Партнёрский код", "ID платежа", "Статус оплаты", "Дата оплаты",
        "Статус диагностики", "Дата завершения", "Статус PDF в Results-боте",
        "Telegram file_id", "Telegram file_unique_id", "Последнее обновление"
      ];
      const addedHeaders = [
        "Ссылка на диагностику",
        "Статус письма со ссылкой на диагностику",
        "Дата отправки письма со ссылкой",
        "ID письма со ссылкой",
        "Ошибка письма со ссылкой",
        "Ссылка на сообщение с PDF в Telegram",
        "Статус отправки PDF на email",
        "Дата отправки PDF на email",
        "ID письма с PDF",
        "Ошибка отправки PDF на email"
      ];
      const headers = legacyHeaders.concat(addedHeaders);

      if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.setFrozenRows(1);
      } else {
        const currentHeaders = sheet.getRange(1, 1, 1, legacyHeaders.length).getValues()[0];
        if (currentHeaders.join("|") !== legacyHeaders.join("|")) {
          throw new Error('Существующие заголовки листа "Заказы" отличаются от ожидаемых. Данные не изменены.');
        }
        sheet.getRange(1, legacyHeaders.length + 1, 1, addedHeaders.length).setValues([addedHeaders]);
      }

      const diagnosticUrl = order.diagnosticUrl || diagnosticUrl_(order.productKey, token);
      const diagnosticLinkStatus = order.diagnosticLinkEmailStatus ||
        (order.diagnosticLinkEmailSentAt ? "Отправлено" : (order.isPaid === true ? "Ожидает отправки" : "—"));
      const reportEmailStatus = order.reportEmailStatus ||
        (order.reportEmailSentAt ? "Отправлено" : (order.isCompleted === true ? "Ожидает отправки" : "—"));
      const now = new Date();

      const row = [
        dateOrBlank_(order.createdAt),
        safeText_(token),
        safeText_(order.studentName),
        safeText_(order.email),
        safeText_(order.productKey),
        safeText_(order.productTitle),
        numberOrBlank_(order.displayAmount),
        numberOrBlank_(order.listPrice),
        numberOrBlank_(order.discountAmount),
        numberOrBlank_(order.discountPercent),
        safeText_(order.promoCode),
        safeText_(order.referralCode),
        safeText_(order.paymentId),
        order.isPaid === true ? "Оплачен" : (order.paymentCreationFailed === true ? "Ошибка создания платежа" : "Ожидает оплаты"),
        dateOrBlank_(order.paidAt),
        order.isCompleted === true ? "Завершена" : "Не завершена",
        dateOrBlank_(order.completedAt),
        order.resultsTelegramSentAt ? "Отправлен" : (order.resultsTelegramStatus || "Не отправлен"),
        safeText_(order.resultsTelegramFileId),
        safeText_(order.resultsTelegramFileUniqueId),
        now,
        safeText_(diagnosticUrl),
        safeText_(diagnosticLinkStatus),
        dateOrBlank_(order.diagnosticLinkEmailSentAt),
        safeText_(order.diagnosticLinkEmailId),
        safeText_(order.diagnosticLinkEmailError),
        safeText_(order.resultsTelegramMessageLink),
        safeText_(reportEmailStatus),
        dateOrBlank_(order.reportEmailSentAt),
        safeText_(order.reportEmailId),
        safeText_(order.reportEmailError)
      ];

      const tokenColumn = 2;
      const lastRow = sheet.getLastRow();
      let targetRow = 0;
      if (lastRow >= 2) {
        const matches = sheet.getRange(2, tokenColumn, lastRow - 1, 1)
          .createTextFinder(token)
          .matchEntireCell(true)
          .findNext();
        if (matches) targetRow = matches.getRow();
      }

      if (targetRow) {
        sheet.getRange(targetRow, 1, 1, headers.length).setValues([row]);
      } else {
        sheet.appendRow(row);
        targetRow = sheet.getLastRow();
      }

      // Преобразуем ранее записанные ISO-строки в даты, чтобы вся история
      // отображалась по часовому поясу таблицы Europe/Moscow, а не как UTC-текст.
      const dataRows = Math.max(sheet.getLastRow() - 1, 0);
      if (dataRows > 0) {
        [1, 15, 17, 24, 29].forEach(column => {
          const range = sheet.getRange(2, column, dataRows, 1);
          const values = range.getValues();
          let changed = false;
          const converted = values.map(([value]) => {
            if (typeof value !== "string" || !value.trim()) return [value];
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return [value];
            changed = true;
            return [date];
          });
          if (changed) range.setValues(converted);
        });
        [1, 15, 17, 21, 24, 29].forEach(column => {
          sheet.getRange(2, column, dataRows, 1).setNumberFormat("dd.MM.yyyy HH:mm:ss");
        });
      }
    } finally {
      lock.releaseLock();
    }

    return json_({ success: true, event: String(payload.event || "order_updated") });
  } catch (error) {
    console.error("Order sync error:", error);
    return json_({ success: false, error: String(error && error.message || error) });
  }
}

function diagnosticUrl_(productKey, token) {
  const files = {
    "7": "test_7_basic.html", "7_basic": "test_7_basic.html", "7_advanced": "test_7_advanced.html",
    "8": "test_8_basic.html", "8_basic": "test_8_basic.html", "8_advanced": "test_8_advanced.html",
    "9": "test_9_basic.html", "9_basic": "test_9_basic.html", "9_advanced": "test_9_advanced.html",
    "10": "test_10_basic.html", "10_basic": "test_10_basic.html", "10_advanced": "test_10_advanced.html",
    "11": "test_11_basic.html", "11_basic": "test_11_basic.html", "11_advanced": "test_11_advanced.html"
  };
  const file = files[String(productKey || "")];
  return file ? "https://reshai360.ru/" + file + "?token=" + encodeURIComponent(token) : "";
}

function dateOrBlank_(value) {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? safeText_(value) : date;
}

function safeText_(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  return /^[-=+@]/.test(text) ? "'" + text : text;
}

function numberOrBlank_(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

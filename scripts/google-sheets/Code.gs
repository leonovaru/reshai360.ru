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
      const sheet = spreadsheet.getSheetByName("Заказы") || spreadsheet.insertSheet("Заказы");
      const headers = [
        "Дата создания",
        "Токен заказа",
        "Имя",
        "Email",
        "Ключ продукта",
        "Диагностика",
        "Стоимость, ₽",
        "Цена до скидки, ₽",
        "Скидка, ₽",
        "Скидка, %",
        "Промокод",
        "Партнёрский код",
        "ID платежа",
        "Статус оплаты",
        "Дата оплаты",
        "Статус диагностики",
        "Дата завершения",
        "Статус PDF в Results-боте",
        "Telegram file_id",
        "Telegram file_unique_id",
        "Последнее обновление"
      ];

      if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.setFrozenRows(1);
      } else {
        const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
        if (currentHeaders.join("|") !== headers.join("|")) {
          throw new Error('Структура листа "Заказы" отличается от ожидаемой. Не меняйте заголовки вручную.');
        }
      }

      const now = new Date();
      const row = [
        order.createdAt || "",
        token,
        order.studentName || "",
        order.email || "",
        order.productKey || "",
        order.productTitle || "",
        numberOrBlank_(order.displayAmount),
        numberOrBlank_(order.listPrice),
        numberOrBlank_(order.discountAmount),
        numberOrBlank_(order.discountPercent),
        order.promoCode || "",
        order.referralCode || "",
        order.paymentId || "",
        order.isPaid === true ? "Оплачен" : (order.paymentCreationFailed === true ? "Ошибка создания платежа" : "Ожидает оплаты"),
        order.paidAt || "",
        order.isCompleted === true ? "Завершена" : "Не завершена",
        order.completedAt || "",
        order.resultsTelegramSentAt ? "Отправлен" : "Не отправлен",
        order.resultsTelegramFileId || "",
        order.resultsTelegramFileUniqueId || "",
        now
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

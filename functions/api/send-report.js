export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const formData = await request.formData();
    const email = formData.get('email');
    const name = formData.get('name');
    const score = formData.get('score');
    const total = formData.get('total');
    const pdfFile = formData.get('document');

    const percent = Math.round((parseInt(score) / parseInt(total)) * 100);

    // 1. Отправка отчета в ваш Telegram-бот
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
      const tgFormData = new FormData();
      tgFormData.append('chat_id', env.TG_CHAT_ID);
      tgFormData.append('caption', `🎯 <b>Пройдена диагностика! (11 класс)</b>\n👤 <b>Ученик:</b> ${name}\n📧 <b>Email:</b> ${email}\n📊 <b>Результат:</b> ${score} из ${total} (${percent}%)`);
      tgFormData.append('parse_mode', 'HTML');
      if (pdfFile) {
        tgFormData.append('document', pdfFile, `Отчет_${name}.pdf`);
      }

      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendDocument`, {
        method: 'POST',
        body: tgFormData
      });
    }

    // 2. Отправка письма ученику через Resend API
    if (env.RESEND_API_KEY && pdfFile) {
      const pdfBuffer = await pdfFile.arrayBuffer();
      const base64Pdf = btoa(String.fromCharCode(...new Uint8Array(pdfBuffer)));

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Решай360 <info@reshai360.ru>',
          to: [email],
          subject: `Результаты независимой диагностики по математике (11 класс) — ${name}`,
          html: `
            <p>Здравствуйте, <b>${name}</b>!</p>
            <p>Вы успешно прошли независимую диагностику знаний по математике за 11 класс на платформе <b>Решай360</b>.</p>
            <p>Во вложении к этому письму находится ваш подробный PDF-отчет.</p>
            <p><b>В отчете вы найдете:</b></p>
            <ul>
              <li>Наглядную карту освоения ключевых тем ЕГЭ / школьной программы;</li>
              <li>Подробный разбор допущенных ошибок;</li>
              <li>Рекомендации по темам, на которые стоит обратить внимание в первую очередь.</li>
            </ul>
            <p>С уважением,<br>Команда независимой диагностики <b>Решай360</b><br><a href="https://reshai360.ru">reshai360.ru</a></p>
          `,
          attachments: [
            {
              filename: `Отчет_${name}.pdf`,
              content: base64Pdf
            }
          ]
        })
      });
    }

    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('Send report error:', err);
    return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const formData = await request.formData();
    const token = formData.get('token');
    const email = formData.get('email');
    const name = formData.get('name');
    const score = formData.get('score');
    const total = formData.get('total');
    const pdfFile = formData.get('document');

    const percent = Math.round((parseInt(score) / parseInt(total)) * 100);

    // 1. Жестко помечаем токен как полностью завершенный в KV-хранилище (блокируем повторный вход навсегда)
    if (token && env.TEST_TOKENS) {
      const tokenDataRaw = await env.TEST_TOKENS.get(token);
      if (tokenDataRaw) {
        const tokenData = JSON.parse(tokenDataRaw);
        tokenData.isCompleted = true;
        await env.TEST_TOKENS.put(token, JSON.stringify(tokenData));
      }
    }

    // 2. Отправка отчета в Telegram-бот
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID && pdfFile) {
      try {
        const tgFormData = new FormData();
        tgFormData.append('chat_id', env.TG_CHAT_ID);
        tgFormData.append('caption', `🎯 <b>Пройдена диагностика!</b>\n👤 <b>Ученик:</b> ${name}\n📧 <b>Email:</b> ${email}\n📊 <b>Результат:</b> ${score} из ${total} (${percent}%)`);
        tgFormData.append('parse_mode', 'HTML');
        tgFormData.append('document', pdfFile, `Отчет_${name}.pdf`);

        await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendDocument`, {
          method: 'POST',
          body: tgFormData
        });
      } catch (tgErr) {
        console.error('Telegram send error:', tgErr);
      }
    }

    // 3. Отправка письма ученику через Resend API
    if (env.RESEND_API_KEY && email && pdfFile) {
      try {
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
            subject: `Результаты независимой диагностики по математике — ${name}`,
            html: `
              <p>Здравствуйте, <b>${name}</b>!</p>
              <p>Вы успешно завершили независимую диагностику знаний по математике на платформе <b>Решай360</b>.</p>
              <p>Во вложении к этому письму находится ваш подробный PDF-отчет с анализом результатов и рекомендациями.</p>
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
      } catch (resendErr) {
        console.error('Resend email error:', resendErr);
      }
    }

    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('Send report global error:', err);
    return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500 });
  }
}

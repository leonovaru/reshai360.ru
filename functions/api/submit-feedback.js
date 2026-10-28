export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const token = String(body.token || "").trim();
    const category = String(body.category || "Другое").trim().slice(0, 100);
    const message = String(body.message || "").trim().slice(0, 5000);
    const name = String(body.name || "Не указано").trim().slice(0, 200);
    const email = String(body.email || "").trim().slice(0, 320);
    const promoCode = String(body.promoCode || "").trim().toUpperCase();
    const source = token ? "completed_test" : String(body.source || "website").slice(0, 50);
    if (!message || message.length < 5 || !name || !email) return Response.json({ success:false, message:"Укажите имя, email и напишите сообщение хотя бы из 5 символов." }, {status:400});
    if (!env.TEST_TOKENS) return Response.json({success:false,message:"Хранилище временно недоступно. Попробуйте позже."},{status:503});
    let tokenData=null, promo=null, feedbackId=crypto.randomUUID(), feedbackKey="feedback:"+feedbackId, promoKey=null;
    if (token) {
      if (!promoCode) return Response.json({success:false,message:"Не найден промокод этой диагностики."},{status:400});
      const tokenRaw=await env.TEST_TOKENS.get(token);
      if (!tokenRaw) return Response.json({success:false,message:"Ссылка на диагностику истекла. Обратитесь в поддержку."},{status:403});
      tokenData=JSON.parse(tokenRaw);
      if (!tokenData.isCompleted || tokenData.promoCodeIssued!==promoCode) return Response.json({success:false,message:"Не удалось подтвердить промокод для этой диагностики."},{status:403});
      feedbackKey="feedback:"+token;
      if (await env.TEST_TOKENS.get(feedbackKey)) return Response.json({success:false,message:"Обратная связь для этой диагностики уже отправлена."},{status:409});
      promoKey="promo:"+promoCode;
      const promoRaw=await env.TEST_TOKENS.get(promoKey);
      if (!promoRaw) return Response.json({success:false,message:"Промокод не найден. Напишите в поддержку."},{status:404});
      promo=JSON.parse(promoRaw);
    }
    const feedback={id:feedbackId,createdAt:new Date().toISOString(),source,name,email,productKey:tokenData?(tokenData.productKey||"unknown"):null,category,message,promoCode:promoCode||null,promoDiscountBefore:promo?(Number(promo.discount)||90):null,promoDiscountAfter:promo?190:null};
    await env.TEST_TOKENS.put(feedbackKey,JSON.stringify(feedback),{expirationTtl:31536000});
    if(promo&&promoKey){
      promo.discount=190; promo.feedbackUpgrade=true; promo.feedbackAt=Date.now();
      const ttl=Math.max(60,Math.floor(((promo.expiresAt||(Date.now()+15552000000))-Date.now())/1000));
      await env.TEST_TOKENS.put(promoKey,JSON.stringify(promo),{expirationTtl:ttl});
    }
    let telegramSent=false;
    if(env.TG_BOT_TOKEN&&env.TG_CHAT_ID){
      const lines=["💬 Новая обратная связь — Решай360","Источник: "+source,"Имя: "+name,"Email: "+email,"Диагностика: "+(tokenData?(tokenData.productKey||"не указана"):"не привязана"),"Категория: "+category,promoCode?("Промокод обновлён до скидки 190 ₽: "+promoCode):"","","Сообщение:",message].filter(Boolean);
      try{const response=await fetch("https://api.telegram.org/bot"+env.TG_BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:env.TG_CHAT_ID,text:lines.join("\n")})});telegramSent=response.ok;if(!response.ok)console.error("Telegram feedback error:",await response.text());}catch(error){console.error("Telegram feedback send error:",error);}
    }
    let emailSent=false;
    if(promo&&env.RESEND_API_KEY&&email){
      try{const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:"Решай360 <info@reshai360.ru>",to:[email],subject:"Ваш промокод Решай360 обновлён до скидки 190 ₽",html:"<p>Спасибо за обратную связь! Ваш промокод <b>"+promoCode+"</b> теперь даёт скидку 190 ₽ на следующую диагностику.</p><p>Код одноразовый и действует 180 дней. Вы можете использовать его сами или передать другу.</p><p>Команда <a href='https://reshai360.ru'>Решай360</a></p>"})});emailSent=response.ok;if(!response.ok)console.error("Feedback confirmation email error:",await response.text());}catch(error){console.error("Feedback confirmation email send error:",error);}
    }
    return Response.json({success:true,telegramSent,emailSent,upgraded:Boolean(promo)});
  } catch(error) {
    console.error("Submit feedback error:",error);
    return Response.json({success:false,message:"Не удалось сохранить обратную связь. Попробуйте позже."},{status:500});
  }
}

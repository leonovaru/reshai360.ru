export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const event = await request.json();

    if (event.event === 'payment.succeeded') {
      const payment = event.object;
      const metadata = payment.metadata;
      const token = metadata && metadata.token;

      if (token) {
        const tokenDataRaw = await env.TEST_TOKENS.get(token);
        if (tokenDataRaw) {
          const tokenData = JSON.parse(tokenDataRaw);
          tokenData.isPaid = true;
          await env.TEST_TOKENS.put(token, JSON.stringify(tokenData), { expirationTtl: 86400 });
        }
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    return new Response('Error', { status: 500 });
  }
}

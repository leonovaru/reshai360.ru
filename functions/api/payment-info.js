export async function onRequestGet({ env }) {
  const testMode = env.PAYMENT_TEST_MODE !== 'false';
  return Response.json({
    testMode,
    paymentAmount: testMode ? '1.00' : null,
    currency: 'RUB'
  }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}

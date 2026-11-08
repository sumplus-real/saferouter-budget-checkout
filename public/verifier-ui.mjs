import { verifyReceipt } from './verify.mjs';
const el = (id) => document.getElementById(id);
el('key').addEventListener('change', async () => {
  const file = el('key').files[0];
  if (file && file.size <= 1024) el('trusted').value = await file.text();
});
async function run(tamper) {
  const result = el('result');
  try {
    const file = el('receipt').files[0];
    if (!file || file.size > 1_000_000) throw new Error('Choose a receipt under 1 MB');
    const envelope = JSON.parse(await file.text());
    if (tamper) envelope.body.items[0].amountCents += 1;
    const value = await verifyReceipt(envelope, el('trusted').value);
    result.className = '';
    result.textContent = `Verified · ${value.delivered} accepted · $${(value.totalCents / 100).toFixed(2)} · ${value.paymentMode} · ${value.authorizationStatus}`;
  } catch (error) {
    result.className = 'error';
    result.textContent = 'Rejected · ' + error.message;
  }
}
el('verify').addEventListener('click', () => run(false));
el('tamper').addEventListener('click', () => run(true));

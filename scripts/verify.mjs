import { readFile } from 'node:fs/promises';
import { verifyReceipt } from '../public/verify.mjs';

try {
  const [receipt, trustedKey, option] = process.argv.slice(2);
  if (!receipt || !trustedKey) throw new Error('Usage: npm run verify -- RECEIPT.json TRUSTED_KEY.txt [--tamper]');
  const envelope = JSON.parse(await readFile(receipt, 'utf8'));
  if (option === '--tamper') envelope.body.items[0].amountCents += 1;
  console.log(JSON.stringify(await verifyReceipt(envelope, await readFile(trustedKey, 'utf8')), null, 2));
} catch (error) {
  console.error('Rejected: ' + error.message);
  process.exitCode = 1;
}

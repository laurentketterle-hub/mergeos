// Tests for Stripe PaymentIntent Funding Rail (#232)
const {
  mapStripeStatus,
  buildLedgerProof,
  verifyWebhookSignature,
  handleWebhook,
} = require('./stripe-sandbox.js');

// ============================================================
// STATUS MAPPING TESTS
// ============================================================
console.log('=== Status Mapping Tests ===');

const statusCases = [
  ['requires_payment_method', 'AWAITING_PAYMENT'],
  ['requires_confirmation', 'AWAITING_CONFIRMATION'],
  ['requires_action', 'AWAITING_ACTION'],
  ['processing', 'PROCESSING'],
  ['succeeded', 'PAID'],
  ['canceled', 'CANCELLED'],
  ['requires_capture', 'AWAITING_CAPTURE'],
  ['nonexistent_status', 'UNKNOWN'],
];

let passed = 0;
let failed = 0;

for (const [input, expected] of statusCases) {
  const result = mapStripeStatus(input);
  if (result === expected) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL: mapStripeStatus('${input}') => '${result}', expected '${expected}'`);
  }
}
console.log(`mapStripeStatus: ${passed}/${statusCases.length} passed`);

// ============================================================
// LEDGER PROOF TESTS
// ============================================================
console.log('\n=== Ledger Proof Tests ===');

const mockPaymentIntent = {
  id: 'pi_test_12345',
  amount: 5000,
  currency: 'usd',
  status: 'succeeded',
  created: 1753900000,
  metadata: { project_id: 'prj_001', user_id: 'user_42' },
  last_payment_error: null,
};

const proof = buildLedgerProof(mockPaymentIntent, 'PAID');

const assertions = [
  ['paymentId', proof.paymentId === 'pi_test_12345'],
  ['provider', proof.provider === 'stripe'],
  ['amount', proof.amount === '50.00'],
  ['currency', proof.currency === 'USD'],
  ['status', proof.status === 'PAID'],
  ['stripeStatus', proof.stripeStatus === 'succeeded'],
  ['metadata.project_id', proof.metadata.project_id === 'prj_001'],
];

let ledgerPassed = 0;
let ledgerFailed = 0;

for (const [name, ok] of assertions) {
  if (ok) {
    ledgerPassed++;
  } else {
    ledgerFailed++;
    console.log(`FAIL: buildLedgerProof.${name}`);
  }
}

// Test with payment error
const failedPI = { ...mockPaymentIntent, status: 'requires_payment_method', last_payment_error: { message: 'Card declined' } };
const failedProof = buildLedgerProof(failedPI, 'AWAITING_PAYMENT');
if (failedProof.lastPaymentError === 'Card declined') {
  ledgerPassed++;
} else {
  ledgerFailed++;
  console.log('FAIL: buildLedgerProof error propagation');
}

console.log(`buildLedgerProof: ${ledgerPassed}/${assertions.length + 1} passed`);

// ============================================================
// WEBHOOK SIGNATURE VERIFICATION TESTS
// ============================================================
console.log('\n=== Webhook Signature Tests ===');

// Test 1: Missing secret
try {
  const origSecret = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  verifyWebhookSignature('{}', 't=123,v1=abc');
  console.log('FAIL: Should throw on missing secret');
  failed++;
} catch (e) {
  if (e.message.includes('STRIPE_WEBHOOK_SECRET')) {
    passed++;
  } else {
    console.log(`FAIL: Wrong error: ${e.message}`);
    failed++;
  }
}

// Test 2: Missing signature header
try {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  verifyWebhookSignature('{}', '');
  console.log('FAIL: Should throw on missing signature');
  failed++;
} catch (e) {
  if (e.message.includes('Missing stripe-signature')) {
    passed++;
  } else {
    console.log(`FAIL: Wrong error: ${e.message}`);
    failed++;
  }
}

// Test 3: Invalid signature format
try {
  verifyWebhookSignature('{}', 'invalid_format');
  console.log('FAIL: Should throw on invalid format');
  failed++;
} catch (e) {
  if (e.message.includes('Invalid stripe-signature')) {
    passed++;
  } else {
    console.log(`FAIL: Wrong error: ${e.message}`);
    failed++;
  }
}

// Test 4: Valid signature verification (using crypto to compute correct sig)
const crypto = require('crypto');
const testSecret = 'whsec_test_abc123';
process.env.STRIPE_WEBHOOK_SECRET = testSecret;
const testPayload = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });
const timestamp = Math.floor(Date.now() / 1000).toString();
const signedPayload = `${timestamp}.${testPayload}`;
const validSig = crypto.createHmac('sha256', testSecret).update(signedPayload).digest('hex');

try {
  const result = verifyWebhookSignature(testPayload, `t=${timestamp},v1=${validSig}`);
  if (result.type === 'payment_intent.succeeded') {
    passed++;
  } else {
    console.log('FAIL: Verified event has wrong type');
    failed++;
  }
} catch (e) {
  console.log(`FAIL: Signature verification threw: ${e.message}`);
  failed++;
}

// Test 5: Invalid signature (tampered payload)
try {
  verifyWebhookSignature('{"tampered":true}', `t=${timestamp},v1=${validSig}`);
  console.log('FAIL: Should throw on tampered payload');
  failed++;
} catch (e) {
  if (e.message.includes('verification failed')) {
    passed++;
  } else {
    console.log(`FAIL: Wrong error for tampered: ${e.message}`);
    failed++;
  }
}

console.log(`Webhook signature: tests completed`);
const totalPassed = passed + ledgerPassed;
const totalFailed = failed + ledgerFailed;
console.log(`\n=== TOTAL: ${totalPassed} passed, ${totalFailed} failed ===`);

if (totalFailed > 0) {
  process.exit(1);
}

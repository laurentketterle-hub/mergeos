// Stripe PaymentIntent Funding Rail for MergeOS (#232, 100 MRG)
// Sandbox-only: uses STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET from env
const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * Create a Stripe PaymentIntent for project escrow funding.
 * @param {number} amount - Amount in USD (minor units, e.g. 50.00)
 * @param {string} currency - ISO 4217 currency code (default 'usd')
 * @param {object} metadata - Optional metadata (projectId, userId, etc.)
 * @returns {Promise<object>} PaymentIntent object from Stripe
 */
async function createPaymentIntent(amount, currency = 'usd', metadata = {}) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required');
  }

  const body = new URLSearchParams({
    amount: Math.round(amount * 100), // convert to cents
    currency: currency.toLowerCase(),
    'metadata[project_id]': metadata.projectId || '',
    'metadata[user_id]': metadata.userId || '',
    'metadata[source]': 'mergeos-escrow',
  });

  const response = await fetch(`${STRIPE_API}/payment_intents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Stripe PaymentIntent creation failed: ${err.error?.message || response.statusText}`);
  }

  return response.json();
}

/**
 * Verify a Stripe webhook signature.
 * Uses STRIPE_WEBHOOK_SECRET from environment.
 * @param {string} payload - Raw request body (string)
 * @param {string} sigHeader - Value of the stripe-signature header
 * @returns {object} Verified event object from Stripe
 */
function verifyWebhookSignature(payload, sigHeader) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
  }

  if (!sigHeader) {
    throw new Error('Missing stripe-signature header');
  }

  // Parse signature header: t=timestamp,v1=signature[,v1=other_sig]
  const parts = sigHeader.split(',').map(p => p.trim());
  const timestampPart = parts.find(p => p.startsWith('t='));
  const sigParts = parts.filter(p => p.startsWith('v1='));

  if (!timestampPart || sigParts.length === 0) {
    throw new Error('Invalid stripe-signature header format');
  }

  const timestamp = timestampPart.substring(2);
  const signatures = sigParts.map(p => p.substring(3));

  // Verify at least one signature matches
  const crypto = require('crypto');
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload)
    .digest('hex');

  const isValid = signatures.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
    } catch {
      return false;
    }
  });

  if (!isValid) {
    throw new Error('Webhook signature verification failed');
  }

  // Parse and return the verified event
  return JSON.parse(payload);
}

/**
 * Map Stripe PaymentIntent status to MergeOS payment status.
 * @param {string} stripeStatus - PaymentIntent status from Stripe
 * @returns {string} MergeOS payment status
 */
function mapStripeStatus(stripeStatus) {
  const statusMap = {
    'requires_payment_method': 'AWAITING_PAYMENT',
    'requires_confirmation': 'AWAITING_CONFIRMATION',
    'requires_action': 'AWAITING_ACTION',
    'processing': 'PROCESSING',
    'succeeded': 'PAID',
    'canceled': 'CANCELLED',
    'requires_capture': 'AWAITING_CAPTURE',
  };
  return statusMap[stripeStatus] || 'UNKNOWN';
}

/**
 * Build a ledger proof entry for a Stripe payment.
 * @param {object} paymentIntent - Stripe PaymentIntent object
 * @param {string} mergeosStatus - Mapped MergeOS status
 * @returns {object} Ledger proof entry
 */
function buildLedgerProof(paymentIntent, mergeosStatus) {
  return {
    paymentId: paymentIntent.id,
    provider: 'stripe',
    amount: (paymentIntent.amount / 100).toFixed(2),
    currency: paymentIntent.currency?.toUpperCase() || 'USD',
    status: mergeosStatus,
    stripeStatus: paymentIntent.status,
    createdAt: new Date(paymentIntent.created * 1000).toISOString(),
    metadata: paymentIntent.metadata || {},
    lastPaymentError: paymentIntent.last_payment_error?.message || null,
  };
}

/**
 * Handle a Stripe webhook event and produce a MergeOS ledger operation.
 * @param {string} rawBody - Raw request body
 * @param {string} signatureHeader - stripe-signature header value
 * @returns {object} { event, status, ledgerProof }
 */
function handleWebhook(rawBody, signatureHeader) {
  const event = verifyWebhookSignature(rawBody, signatureHeader);

  let mergeosStatus = 'UNKNOWN';
  let ledgerProof = null;

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      mergeosStatus = 'PAID';
      ledgerProof = buildLedgerProof(pi, mergeosStatus);
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      mergeosStatus = 'FAILED';
      ledgerProof = buildLedgerProof(pi, mergeosStatus);
      break;
    }
    case 'payment_intent.canceled': {
      const pi = event.data.object;
      mergeosStatus = 'CANCELLED';
      ledgerProof = buildLedgerProof(pi, mergeosStatus);
      break;
    }
    case 'payment_intent.processing': {
      const pi = event.data.object;
      mergeosStatus = 'PROCESSING';
      ledgerProof = buildLedgerProof(pi, mergeosStatus);
      break;
    }
    default:
      // Unhandled event type — safe to ignore
      break;
  }

  return { event, status: mergeosStatus, ledgerProof };
}

module.exports = {
  createPaymentIntent,
  verifyWebhookSignature,
  mapStripeStatus,
  buildLedgerProof,
  handleWebhook,
};

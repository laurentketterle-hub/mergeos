"""Stripe PaymentIntent funding rail for project escrow."""

import os
import json
import hashlib
import hmac
import time

# In production, use: import stripe; stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
# This is a standalone implementation for environments without the stripe package.

STRIPE_SECRET = os.getenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder")
STRIPE_PUBLISHABLE = os.getenv("STRIPE_PUBLISHABLE_KEY", "pk_test_placeholder")

# Simulated ledger
_ledger = []


class PaymentIntentError(Exception):
    """Raised when PaymentIntent operations fail."""
    pass


class SignatureError(Exception):
    """Raised when webhook signature verification fails."""
    pass


class PaymentIntent:
    """Represents a Stripe PaymentIntent."""
    STATUS_VALID_TRANSITIONS = {
        "requires_payment_method": ["requires_confirmation", "canceled"],
        "requires_confirmation": ["processing", "canceled"],
        "processing": ["succeeded", "failed"],
        "succeeded": ["refunded"],
        "canceled": [],
        "failed": [],
        "refunded": [],
    }

    def __init__(self, id, amount, currency="usd", metadata=None):
        self.id = id
        self.amount = amount
        self.currency = currency
        self.status = "requires_payment_method"
        self.metadata = metadata or {}
        self.created = int(time.time())
        self.client_secret = f"{id}_secret_{hashlib.sha256(os.urandom(16)).hexdigest()[:16]}"

    def transition(self, new_status):
        if new_status not in self.STATUS_VALID_TRANSITIONS.get(self.status, []):
            raise PaymentIntentError(
                f"Cannot transition from '{self.status}' to '{new_status}'"
            )
        self.status = new_status

    def to_dict(self):
        return {
            "id": self.id,
            "amount": self.amount,
            "currency": self.currency,
            "status": self.status,
            "client_secret": self.client_secret,
            "metadata": self.metadata,
            "created": self.created,
        }


# In-memory store
_payment_intents = {}


def create_payment_intent(amount, currency="usd", metadata=None):
    """Create a Stripe PaymentIntent for escrow funding."""
    if amount <= 0:
        raise PaymentIntentError("amount must be positive")
    if currency not in ("usd", "eur", "gbp"):
        raise PaymentIntentError(f"unsupported currency: {currency}")

    pi_id = f"pi_{hashlib.sha256(os.urandom(16)).hexdigest()[:24]}"
    pi = PaymentIntent(pi_id, amount, currency, metadata)
    _payment_intents[pi_id] = pi

    # Write to proof ledger
    _ledger.append({
        "type": "payment_intent.created",
        "payment_intent_id": pi_id,
        "amount": amount,
        "currency": currency,
        "timestamp": pi.created,
    })

    return pi.to_dict()


def confirm_payment_intent(payment_intent_id):
    """Confirm a PaymentIntent (simulating successful payment)."""
    pi = _payment_intents.get(payment_intent_id)
    if not pi:
        raise PaymentIntentError(f"PaymentIntent {payment_intent_id} not found")

    pi.transition("requires_confirmation")
    pi.transition("processing")
    pi.transition("succeeded")

    # Ledger: mint MRG credit
    mrg_amount = int(pi.amount * 100)  # 1 USD = 100 MRG
    _ledger.append({
        "type": "payment.succeeded",
        "payment_intent_id": payment_intent_id,
        "amount_usd": pi.amount,
        "mrg_credited": mrg_amount,
        "timestamp": int(time.time()),
    })

    return pi.to_dict()


def get_payment_intent(payment_intent_id):
    """Retrieve a PaymentIntent by ID."""
    pi = _payment_intents.get(payment_intent_id)
    if not pi:
        raise PaymentIntentError(f"PaymentIntent {payment_intent_id} not found")
    return pi.to_dict()


def list_payment_intents(status=None):
    """List all PaymentIntents, optionally filtered by status."""
    result = [pi.to_dict() for pi in _payment_intents.values()]
    if status:
        result = [pi for pi in result if pi["status"] == status]
    return result


def get_ledger():
    """Return the full proof ledger."""
    return list(_ledger)


# ─── Webhook signature verification ───

def verify_webhook_signature(payload, signature_header):
    """Verify Stripe webhook signature.

    Args:
        payload: Raw request body bytes.
        signature_header: Value of the Stripe-Signature header.

    Returns:
        dict: Verified event data.

    Raises:
        SignatureError: If signature is invalid.
    """
    if not signature_header:
        raise SignatureError("Missing Stripe-Signature header")

    # Parse t= and v1= from header
    parts = {}
    for part in signature_header.split(","):
        part = part.strip()
        if "=" in part:
            key, value = part.split("=", 1)
            parts[key] = value

    timestamp = parts.get("t", "")
    signature = parts.get("v1", "")

    if not timestamp or not signature:
        raise SignatureError("Invalid signature header format")

    # Check timestamp freshness (5 minute tolerance)
    try:
        ts = int(timestamp)
        now = int(time.time())
        if abs(now - ts) > 300:
            raise SignatureError("Signature timestamp too old")
    except ValueError:
        raise SignatureError("Invalid timestamp")

    # Compute expected signature
    signed_payload = f"{timestamp}.{payload if isinstance(payload, str) else payload.decode()}"
    expected = hmac.new(
        STRIPE_WEBHOOK_SECRET.encode(),
        signed_payload.encode(),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        raise SignatureError("Signature mismatch")

    # Parse and return event
    event = json.loads(payload) if isinstance(payload, str) else json.loads(payload)
    return event


def handle_webhook_event(event):
    """Process a verified webhook event."""
    event_type = event.get("type", "")
    data = event.get("data", {}).get("object", {})

    if event_type == "payment_intent.succeeded":
        pi_id = data.get("id", "")
        if pi_id in _payment_intents:
            _payment_intents[pi_id].status = "succeeded"
            _ledger.append({
                "type": "webhook.payment_intent.succeeded",
                "payment_intent_id": pi_id,
                "timestamp": int(time.time()),
            })
        return {"status": "processed", "event": event_type}

    elif event_type == "payment_intent.payment_failed":
        pi_id = data.get("id", "")
        if pi_id in _payment_intents:
            _payment_intents[pi_id].status = "failed"
        return {"status": "processed", "event": event_type}

    return {"status": "ignored", "event": event_type}

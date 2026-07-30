"""Tests for Stripe PaymentIntent funding rail."""

import sys
import os
import json
import time
import hashlib
import hmac

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server', 'stripe'))

from payment import (
    create_payment_intent,
    confirm_payment_intent,
    get_payment_intent,
    list_payment_intents,
    get_ledger,
    verify_webhook_signature,
    handle_webhook_event,
    PaymentIntentError,
    SignatureError,
    PaymentIntent,
    STRIPE_WEBHOOK_SECRET,
    STRIPE_SECRET,
    _payment_intents,
    _ledger,
)


def setup_function():
    """Clear state before each test."""
    _payment_intents.clear()
    _ledger.clear()


class TestPaymentIntentCreation:
    """Test PaymentIntent creation."""

    def test_create_valid_pi(self):
        pi = create_payment_intent(amount=5000, currency="usd")
        assert pi["amount"] == 5000
        assert pi["currency"] == "usd"
        assert pi["status"] == "requires_payment_method"
        assert pi["id"].startswith("pi_")
        assert "client_secret" in pi

    def test_create_negative_amount_fails(self):
        try:
            create_payment_intent(amount=-100)
            assert False, "Should have raised"
        except PaymentIntentError:
            pass

    def test_create_zero_amount_fails(self):
        try:
            create_payment_intent(amount=0)
            assert False, "Should have raised"
        except PaymentIntentError:
            pass

    def test_create_unsupported_currency_fails(self):
        try:
            create_payment_intent(amount=1000, currency="xyz")
            assert False, "Should have raised"
        except PaymentIntentError:
            pass

    def test_create_with_metadata(self):
        pi = create_payment_intent(amount=2000, metadata={"project_id": "proj_1"})
        assert pi["metadata"]["project_id"] == "proj_1"

    def test_ledger_entry_on_create(self):
        create_payment_intent(amount=3000)
        ledger = get_ledger()
        assert len(ledger) == 1
        assert ledger[0]["type"] == "payment_intent.created"
        assert ledger[0]["amount"] == 3000


class TestPaymentIntentConfirmation:
    """Test PaymentIntent confirmation flow."""

    def test_confirm_succeeds(self):
        pi = create_payment_intent(amount=1000)
        confirmed = confirm_payment_intent(pi["id"])
        assert confirmed["status"] == "succeeded"

    def test_confirm_not_found(self):
        try:
            confirm_payment_intent("pi_nonexistent")
            assert False, "Should have raised"
        except PaymentIntentError:
            pass

    def test_confirm_credits_mrg(self):
        pi = create_payment_intent(amount=50)  # 50 USD = 5000 MRG
        confirm_payment_intent(pi["id"])
        ledger = get_ledger()
        assert any(e["type"] == "payment.succeeded" for e in ledger)
        succeeded = [e for e in ledger if e["type"] == "payment.succeeded"][0]
        assert succeeded["mrg_credited"] == 5000


class TestPaymentIntentRetrieval:
    """Test retrieval."""

    def test_get_existing(self):
        pi = create_payment_intent(amount=999)
        retrieved = get_payment_intent(pi["id"])
        assert retrieved["amount"] == 999

    def test_get_nonexistent(self):
        try:
            get_payment_intent("pi_bogus")
            assert False, "Should have raised"
        except PaymentIntentError:
            pass

    def test_list_all(self):
        create_payment_intent(amount=100)
        create_payment_intent(amount=200)
        assert len(list_payment_intents()) == 2

    def test_list_by_status(self):
        create_payment_intent(amount=100)
        pi2 = create_payment_intent(amount=200)
        confirm_payment_intent(pi2["id"])
        succeeded = list_payment_intents(status="succeeded")
        pending = list_payment_intents(status="requires_payment_method")
        assert len(succeeded) == 1
        assert len(pending) == 1


class TestWebhookSignature:
    """Test webhook signature verification."""

    def test_valid_signature(self):
        payload = json.dumps({"type": "payment_intent.succeeded", "data": {"object": {"id": "pi_test"}}})
        timestamp = str(int(time.time()))
        signed = f"{timestamp}.{payload}"
        sig = hmac.new(STRIPE_WEBHOOK_SECRET.encode(), signed.encode(), hashlib.sha256).hexdigest()
        header = f"t={timestamp},v1={sig}"

        event = verify_webhook_signature(payload, header)
        assert event["type"] == "payment_intent.succeeded"

    def test_missing_header(self):
        try:
            verify_webhook_signature("{}", "")
            assert False, "Should have raised"
        except SignatureError:
            pass

    def test_mismatched_signature(self):
        payload = json.dumps({"type": "test"})
        timestamp = str(int(time.time()))
        signed = f"{timestamp}.{payload}"
        # Use wrong secret
        sig = hmac.new(b"wrong_secret", signed.encode(), hashlib.sha256).hexdigest()
        header = f"t={timestamp},v1={sig}"

        try:
            verify_webhook_signature(payload, header)
            assert False, "Should have raised"
        except SignatureError as e:
            assert "mismatch" in str(e).lower()

    def test_old_timestamp(self):
        payload = json.dumps({"type": "test"})
        old_ts = str(int(time.time()) - 600)  # 10 min old
        signed = f"{old_ts}.{payload}"
        sig = hmac.new(STRIPE_WEBHOOK_SECRET.encode(), signed.encode(), hashlib.sha256).hexdigest()
        header = f"t={old_ts},v1={sig}"

        try:
            verify_webhook_signature(payload, header)
            assert False, "Should have raised"
        except SignatureError as e:
            assert "old" in str(e).lower()


class TestWebhookHandler:
    """Test webhook event processing."""

    def test_succeeded_event_updates_status(self):
        pi = create_payment_intent(amount=1000)
        event = {"type": "payment_intent.succeeded", "data": {"object": {"id": pi["id"]}}}
        result = handle_webhook_event(event)
        assert result["status"] == "processed"
        assert _payment_intents[pi["id"]].status == "succeeded"

    def test_failed_event(self):
        pi = create_payment_intent(amount=1000)
        event = {"type": "payment_intent.payment_failed", "data": {"object": {"id": pi["id"]}}}
        result = handle_webhook_event(event)
        assert result["status"] == "processed"
        assert _payment_intents[pi["id"]].status == "failed"

    def test_unknown_event_ignored(self):
        event = {"type": "charge.refunded", "data": {"object": {}}}
        result = handle_webhook_event(event)
        assert result["status"] == "ignored"


class TestPaymentIntentTransitions:
    """Test state machine transitions."""

    def test_valid_transition_path(self):
        pi = PaymentIntent("pi_test", 1000)
        assert pi.status == "requires_payment_method"
        pi.transition("requires_confirmation")
        assert pi.status == "requires_confirmation"
        pi.transition("processing")
        assert pi.status == "processing"
        pi.transition("succeeded")
        assert pi.status == "succeeded"

    def test_invalid_transition(self):
        pi = PaymentIntent("pi_test", 1000)
        try:
            pi.transition("succeeded")  # Can't jump from requires_payment_method to succeeded
            assert False, "Should have raised"
        except PaymentIntentError:
            pass

    def test_succeeded_can_be_refunded(self):
        pi = PaymentIntent("pi_test", 1000)
        pi.transition("requires_confirmation")
        pi.transition("processing")
        pi.transition("succeeded")
        pi.transition("refunded")
        assert pi.status == "refunded"

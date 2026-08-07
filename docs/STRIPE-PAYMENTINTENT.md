# Stripe PaymentIntent — Project Escrow Funding Rail

MergeOS supports **Stripe PaymentIntent** as a funding rail for project
escrow deposits. When a project creator selects Stripe, a PaymentIntent
is created server-side and the client confirms it on the frontend.

## Flow

1. **Client** calls `POST /api/payment/stripe/create-intent` with
   `amount_cents`, `project_id`, and optional `description`.
2. **Backend** creates a Stripe PaymentIntent via the Stripe Go SDK,
   records a `PaymentOrderIntent`, and returns the `client_secret`.
3. **Frontend** uses Stripe Elements (`stripe.confirmPayment`) to
   collect payment details and confirm the intent.
4. **Webhook** (`POST /api/payment/stripe/webhook`) receives
   `payment_intent.succeeded` events, verifies the signature, and
   marks the escrow deposit as confirmed.
5. Funds are held in the platform Stripe account until project
   completion or dispute resolution.

## Configuration

| Env variable               | Description                     |
|----------------------------|---------------------------------|
| `STRIPE_SECRET_KEY`        | Stripe secret key (sk_live_…)   |
| `STRIPE_WEBHOOK_SECRET`    | Webhook signing secret (whsec_) |
| `STRIPE_PUBLISHABLE_KEY`   | Client-side key (pk_live_…)     |

## Dev / Test Mode

Set `STRIPE_SECRET_KEY` to a test key (`sk_test_…`). All PaymentIntents
use Stripe test cards (e.g. `4242 4242 4242 4242`). No real charges
are processed.

## Idempotency

Each PaymentIntent request includes an `Idempotency-Key` header derived
from `project_id + amount_cents` to prevent duplicate charges on retry.

## Escrow Lifecycle

```
CREATED → CONFIRMED (payment_intent.succeeded)
       → CANCELLED (payment_intent.cancelled / timeout)
       → DISPUTED (charge.dispute.created)
```

After escrow release, funds are transferred to the contributor via
Stripe Connect or manual payout.

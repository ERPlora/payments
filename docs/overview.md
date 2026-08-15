# Payments — Overview

## What this module does

Payments records money **going out**: paying a supplier, a transfer, a refund. Each payment is
created as a draft, approved, marked as sent to the bank, and finally marked as completed — or
cancelled with a reason. Every one gets a unique reference, `PAY-YYYYMMDD-NNNN`, allocated atomically
per hub and day.

It also holds the catalogue of **payment methods** used to send money: the bank account, the card,
cash.

## This is the opposite of the till

Do not confuse the two:

- **`sales`** records money **coming in** from customers — a sale, a receipt, a payment method the
  customer used.
- **`payments`** records money **going out** — to a supplier, a beneficiary, a bank account.

They have nothing to do with each other. A payment method here is where **you** pay from, not how a
customer pays you.

## What this module does NOT do

- **It does not move any money.** Nothing talks to a bank, generates a SEPA file or executes a
  transfer. "Sent" means a human marked it sent.
- **It does not manage supplier invoices.** It stores a free-text reference to one.
- **It does not touch the till.** No cash movement is created in `cash_register`.
- **It does not do accounting**, reconciliation or ledgers.
- **It does not validate an IBAN.** The beneficiary IBAN is stored as given.

## Modules it connects to

**Depends on nothing**, and nothing depends on it. Its events are on the bus; no module listens to
them today.

**Events it emits**

| Event | When |
|---|---|
| `payments.payment.created` | a payment is created as a draft |
| `payments.payment.approved` | it is approved |
| `payments.payment.sent` | it is marked sent |
| `payments.payment.completed` | it is marked completed |
| `payments.payment.cancelled` | it is cancelled |

**Events it listens to** — none.

The payments screen subscribes to all five to refresh itself live, but that is client-side
reactivity, not a cross-module listener.

## The lifecycle

```
draft ──▶ approved ──▶ sent ──▶ completed
  └───────────┴──────────┴──▶ cancelled
```

A payment that is already `completed` or `cancelled` cannot move again.

## Where its numbers come from

- **Amounts are integer cents** (ADR-0007 / ADR-0123). `12550` is 125,50 €.
- **The currency** is a three-letter code, `EUR` by default, stored uppercase.
- **References** are `PAY-YYYYMMDD-NNNN`, unique per hub, from an atomic per-day counter. The day
  comes from the **server clock**, not from the payment date.
- **Payment dates** are ISO: a plain `YYYY-MM-DD` is read as midnight UTC, and a full timestamp
  without a zone is read as UTC.

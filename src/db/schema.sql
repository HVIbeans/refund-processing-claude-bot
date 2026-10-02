-- Mock refunds database. Money is stored as integer paise; dates are ISO-8601 strings.
-- Constraints here are a backstop; the tool code (step 6) enforces the refund policy.

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  phone      TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'flagged', 'suspended')),
  tier       TEXT NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'vip')),
  created_at TEXT NOT NULL
);

CREATE TABLE orders (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  description  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('placed', 'shipped', 'delivered', 'cancelled')),
  placed_at    TEXT NOT NULL,
  delivered_at TEXT,
  currency     TEXT NOT NULL DEFAULT 'INR',
  total        INTEGER NOT NULL CHECK (total > 0),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

-- Cards on file. Identity is verified with email + the last 4 digits of any of these.
CREATE TABLE payment_methods (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  brand       TEXT NOT NULL CHECK (brand IN ('visa', 'mastercard', 'rupay')),
  last4       TEXT NOT NULL CHECK (length(last4) = 4 AND last4 NOT GLOB '*[^0-9]*'),
  exp_month   INTEGER NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year    INTEGER NOT NULL
);

-- Exactly one payment per order; refunds go back to this payment's card.
CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL UNIQUE REFERENCES orders(id),
  payment_method_id TEXT NOT NULL REFERENCES payment_methods(id),
  amount            INTEGER NOT NULL CHECK (amount > 0),
  status            TEXT NOT NULL CHECK (status IN ('captured', 'pending', 'failed', 'disputed')),
  captured_at       TEXT
);

CREATE TABLE refunds (
  id              TEXT PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES payments(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  reason          TEXT NOT NULL CHECK (reason IN ('damaged', 'wrong_item', 'not_as_described')),
  reason_details  TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending_approval', 'completed', 'rejected')),
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_at    TEXT NOT NULL,
  resolved_at     TEXT,
  resolved_by     TEXT CHECK (resolved_by IN ('agent', 'human')),
  CHECK ((status = 'pending_approval') = (resolved_at IS NULL))
);

CREATE TABLE escalations (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('refund_approval', 'account', 'risk')),
  customer_id     TEXT REFERENCES customers(id),  -- NULL when the customer couldn't be verified
  contact_email   TEXT,
  order_id        TEXT REFERENCES orders(id),
  refund_id       TEXT UNIQUE REFERENCES refunds(id),
  summary         TEXT NOT NULL,                  -- the agent's hand-off summary for the human
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  resolution_note TEXT,
  CHECK (customer_id IS NOT NULL OR contact_email IS NOT NULL),
  CHECK (type <> 'refund_approval' OR refund_id IS NOT NULL)
);

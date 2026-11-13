-- Vehicle refrigerant capacity database for Andy Auto AC Regas.
-- Apply with:
--   npx wrangler d1 execute andy-auto-db --remote --file=schema.sql
-- (or --local for local dev)

CREATE TABLE IF NOT EXISTS vehicles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  make        TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  year_start  INTEGER NOT NULL,
  year_end    INTEGER NOT NULL,
  -- Empty string means the entry applies to every variant of the model.
  -- Non-empty examples: "Hybrid", "Petrol", "Diesel", "2.5L", "GUN126R".
  variant     TEXT    NOT NULL DEFAULT '',
  -- "R134a" or "R1234yf" — critical for pricing (R1234yf is 5-10x more expensive).
  refrigerant TEXT    NOT NULL,
  charge_g    INTEGER NOT NULL,
  notes       TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vehicles_make_model
  ON vehicles(make COLLATE NOCASE, model COLLATE NOCASE);

-- Customer profile. SMS customers key on phone, FB customers key on PSID.
-- Both are UNIQUE where non-null so a row can be keyed by either (or both
-- if a customer is ever linked across channels).
CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT,
  psid            TEXT,
  name            TEXT,
  first_seen      INTEGER,          -- unix seconds
  last_seen       INTEGER,
  visit_count     INTEGER NOT NULL DEFAULT 0,
  total_paid      INTEGER NOT NULL DEFAULT 0,   -- cents
  notes           TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone
  ON customers(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_psid
  ON customers(psid) WHERE psid IS NOT NULL;

-- Per-booking marking (status/payment/actual) sits alongside the iCloud
-- Calendar event (joined by UID). The Calendar is still the source of
-- truth for time/location; this table is everything that accumulates
-- after the service is done.
CREATE TABLE IF NOT EXISTS bookings_meta (
  calendar_uid    TEXT PRIMARY KEY,
  phone           TEXT,              -- snapshot for fast queries
  psid            TEXT,              -- snapshot for fast queries
  status          TEXT,              -- done / partial / no_show / cancelled
  actual_amount   INTEGER,           -- cents, nullable
  payment_method  TEXT,              -- cash / payid / mixed / unpaid
  paid_at         INTEGER,
  our_notes       TEXT NOT NULL DEFAULT '',
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_meta_phone ON bookings_meta(phone);
CREATE INDEX IF NOT EXISTS idx_bookings_meta_paid_at ON bookings_meta(paid_at);

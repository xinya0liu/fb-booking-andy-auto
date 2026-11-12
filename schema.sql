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
  oil_type    TEXT    NOT NULL DEFAULT '',   -- PAG46 / PAG100 / PAG150 / ND-Oil8 …
  oil_ml      INTEGER NOT NULL DEFAULT 0,
  notes       TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vehicles_make_model
  ON vehicles(make COLLATE NOCASE, model COLLATE NOCASE);

#!/usr/bin/env python3
"""Parse Hychill AC charge weights CSV into vehicle rows for D1 import.

Input columns:
  manufacturer, model, variant, date_range, notes,
  R134a_g, R1234yf_g, R12_g, Minus30_g, url

We only keep rows that have R134a_g or R1234yf_g (Andy doesn't service
R12 or Minus30). Each refrigerant becomes its own output row — so a
"both R134a and R1234yf" entry produces two rows.
"""
import csv, re, sys, time

CSV_PATH = '/Users/liuxinya/Downloads/hychill_charge_weights.csv'
MAX_YEAR = 2100

def norm_make(s):
    s = (s or '').strip()
    if not s:
        return ''
    mapping = {'VW': 'Volkswagen', 'BMW': 'BMW', 'MG': 'MG', 'AUDI': 'Audi'}
    if s.upper() in mapping:
        return mapping[s.upper()]
    return ' '.join(w.capitalize() for w in s.split())

def norm_variant(s):
    s = (s or '').strip()
    if not s:
        return ''
    # Collapse whitespace
    s = re.sub(r'\s+', ' ', s)
    return s

def parse_date_range(s):
    """Return (year_start, year_end). Supports:
       '2006-2012', '1985 1986' (space), '2012>', '2007-2010'.
    """
    s = (s or '').strip()
    if not s:
        return None
    # YYYY-YYYY or YYYY YYYY
    m = re.match(r'^\s*(\d{4})\s*[-\s]\s*(\d{4})\s*$', s)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    # YYYY>  (open-ended)
    m = re.match(r'^\s*(\d{4})\s*[>+]\s*$', s)
    if m:
        return (int(m.group(1)), MAX_YEAR)
    # Just YYYY
    m = re.match(r'^\s*(\d{4})\s*$', s)
    if m:
        return (int(m.group(1)), MAX_YEAR)
    return None

def parse_charge(s):
    s = (s or '').strip()
    if not s:
        return None
    m = re.match(r'^(\d{2,5})$', s)
    if m:
        return int(m.group(1))
    return None

def parse_all():
    results = []
    skipped = 0
    with open(CSV_PATH, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            make = norm_make(row.get('manufacturer', ''))
            model = (row.get('model') or '').strip()
            variant = norm_variant(row.get('variant', ''))
            yr = parse_date_range(row.get('date_range', ''))
            r134 = parse_charge(row.get('R134a_g', ''))
            r1234 = parse_charge(row.get('R1234yf_g', ''))
            notes = (row.get('notes') or '').strip()
            if not make or not model or not yr:
                skipped += 1
                continue
            if r134 is None and r1234 is None:
                # Likely R12 / Minus30 only — we don't service those
                skipped += 1
                continue
            year_start, year_end = yr
            if r134 is not None:
                results.append({
                    'make': make, 'model': model, 'variant': variant,
                    'year_start': year_start, 'year_end': year_end,
                    'refrigerant': 'R134a', 'charge_g': r134, 'notes': notes,
                })
            if r1234 is not None:
                results.append({
                    'make': make, 'model': model, 'variant': variant,
                    'year_start': year_start, 'year_end': year_end,
                    'refrigerant': 'R1234yf', 'charge_g': r1234, 'notes': notes,
                })
    return results, skipped

if __name__ == '__main__':
    rows, skipped = parse_all()
    print(f'parsed: {len(rows)}', file=sys.stderr)
    print(f'skipped: {skipped}', file=sys.stderr)
    if len(sys.argv) > 1 and sys.argv[1] == 'sample':
        for r in rows[:8]:
            print(r)
    elif len(sys.argv) > 1 and sys.argv[1] == 'sql':
        now = int(time.time())
        esc = lambda s: str(s).replace("'", "''")
        for r in rows:
            print(
                "INSERT INTO vehicles (make, model, year_start, year_end, variant, refrigerant, charge_g, notes, updated_at, source) VALUES "
                f"('{esc(r['make'])}', '{esc(r['model'])}', {r['year_start']}, {r['year_end']}, "
                f"'{esc(r['variant'])}', '{r['refrigerant']}', {r['charge_g']}, '{esc(r['notes'])}', {now}, 'hychill');"
            )

#!/usr/bin/env python3
"""Parse Nissens AC refrigerant/oil CSV into vehicle rows for D1 import.

Input CSV columns:
  make, model, engine_version, manufactured_from, gas,
  refrigerant_quantity, refrigerant_quantity_tolerance,
  oil, oil_quantity, oe_oil, oe_oil_quantity, info, car_truck, fuel_type

Output rows (same shape as GasBook parser):
  {make, model, variant, year_start, year_end, refrigerant, charge_g, notes}
"""
import csv, re, sys, time

CSV_PATH = '/Users/liuxinya/Downloads/nissens_ac_refrigerant_oil.csv'
MAX_YEAR = 2100

# ------------- helpers -------------

def norm_make(s):
    """Title-case, fix common variants."""
    s = s.strip()
    if not s:
        return ''
    # Preserve well-known styling
    mapping = {
        'VW': 'Volkswagen', 'BMW': 'BMW', 'MG': 'MG', 'FIAT': 'Fiat',
        'AUDI': 'Audi', 'TOYOTA': 'Toyota', 'DAF': 'DAF',
    }
    if s.upper() in mapping:
        return mapping[s.upper()]
    # Generic Title Case (handles "ALFA ROMEO" → "Alfa Romeo")
    return ' '.join(w.capitalize() for w in s.split())

def norm_variant(s):
    """Normalize engine_version into a clean variant string."""
    s = (s or '').strip()
    if not s or s.upper() == 'ALL OTHERS':
        return ''
    # European decimal comma → period (e.g. "1,3 ltr" → "1.3L")
    s = re.sub(r'(\d),(\d)', r'\1.\2', s)
    # "ltr" / "Ltr" / "LTR" → "L"
    s = re.sub(r'\s*[lL][tT][rR]\b', 'L', s)
    # Collapse whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def parse_year_range(s):
    """Return (year_start, year_end). Supports:
       '1994', '2.2007', '11.2013', '1994-1995',
       '03.1999-2000', '10.1998-12.1998', '1997-08.1998'.
    """
    s = (s or '').strip()
    if not s:
        return None
    # Helper: extract just the year from a 'YYYY' or 'MM.YYYY' fragment
    def year_only(frag):
        m = re.match(r'^(?:\d{1,2}\.)?(\d{4})$', frag.strip())
        return int(m.group(1)) if m else None
    # Range form: LEFT-RIGHT where either side can be YYYY or MM.YYYY
    if '-' in s:
        parts = s.split('-', 1)
        y1 = year_only(parts[0])
        y2 = year_only(parts[1])
        if y1 and y2:
            return (y1, y2)
        if y1:
            return (y1, MAX_YEAR)
    # Single value
    y = year_only(s)
    if y:
        return (y, MAX_YEAR)
    return None

def parse_charge(s):
    """Return (charge_g_int, extra_note_or_empty).
       Handles:
         '700'            → (700, '')
         '350 g'          → (350, '')
         '425-475'        → (450, 'range 425-475g')
         '500 (RHD 480)'  → (500, 'RHD 480')
         '450/775'        → (450, 'alt 775g')     — slash alternatives, pick first
         '450 or AT=535'  → (450, 'AT=535')       — manual/auto alternatives
         'See manual'     → (None, 'See manual')
    """
    s = (s or '').strip()
    if not s:
        return (None, '')
    # Drop trailing " g" / " gm" / " grams"
    s = re.sub(r'\s*(g|gm|grams?)\b\s*$', '', s, flags=re.IGNORECASE).strip()
    # "or AT=535" / "or MT=450" → pick first number, stash rest
    m = re.match(r'^(\d{2,4})\s+or\s+(.+)$', s, re.IGNORECASE)
    if m:
        return (int(m.group(1)), m.group(2).strip())
    # Slash-separated alternatives: "450/775" → pick first, note second
    m = re.match(r'^(\d{2,4})\s*/\s*(\d{2,4})(.*)$', s)
    if m:
        return (int(m.group(1)), f'alt {m.group(2)}g')
    # Everything-is-text case
    if re.search(r'[a-zA-Z]', s) and not re.search(r'^\d', s):
        return (None, s)
    # Range: 425-475
    m = re.match(r'^(\d{2,4})\s*-\s*(\d{2,4})(.*)$', s)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        mid = int(round(((lo + hi) / 2) / 5) * 5)
        rest = (m.group(3) or '').strip()
        return (mid, f'range {lo}-{hi}g' + (f' {rest}' if rest else ''))
    # Primary + paren: 500 (RHD 480)
    m = re.match(r'^(\d{2,4})\s*\(([^)]+)\)\s*$', s)
    if m:
        return (int(m.group(1)), m.group(2).strip())
    # Plain number
    m = re.match(r'^(\d{2,4})\s*$', s)
    if m:
        return (int(m.group(1)), '')
    return (None, s)

def parse_refrigerant(s):
    """Return list of refrigerant strings to emit (one row per refrigerant).
       'R134a/R1234yf' → both. 'R134a' → just that.
    """
    s = (s or '').strip()
    if not s:
        return []
    # Normalise separators
    parts = re.split(r'\s*/\s*', s)
    out = []
    for p in parts:
        p = p.strip()
        if re.fullmatch(r'R134a', p, re.IGNORECASE):
            out.append('R134a')
        elif re.fullmatch(r'R1234yf|R123yf', p, re.IGNORECASE):   # R123yf = typo
            out.append('R1234yf')
        elif re.fullmatch(r'R12', p, re.IGNORECASE):
            out.append('R12')
        # Skip R744 (CO2-based, we don't service it) and other unknown codes
    return out

# ------------- main -------------

def parse_all():
    results = []
    skipped = 0
    with open(CSV_PATH, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            make = norm_make(row.get('make', ''))
            model = (row.get('model') or '').strip()
            variant = norm_variant(row.get('engine_version', ''))
            yr = parse_year_range(row.get('manufactured_from', ''))
            charge_g, charge_note = parse_charge(row.get('refrigerant_quantity', ''))
            refrigerants = parse_refrigerant(row.get('gas', ''))
            if not make or not model or not yr or not refrigerants or charge_g is None:
                skipped += 1
                continue
            year_start, year_end = yr
            # Build notes: tolerance + info + charge note
            notes_bits = []
            if charge_note:
                notes_bits.append(charge_note)
            tol = (row.get('refrigerant_quantity_tolerance') or '').strip()
            if tol and re.fullmatch(r'\d+', tol):
                notes_bits.append(f'±{tol}g')
            info = (row.get('info') or '').strip()
            if info and info != '-':
                notes_bits.append(info)
            notes = '; '.join(notes_bits)
            for ref in refrigerants:
                results.append({
                    'make': make, 'model': model, 'variant': variant,
                    'year_start': year_start, 'year_end': year_end,
                    'refrigerant': ref, 'charge_g': charge_g, 'notes': notes,
                })
    return results, skipped

if __name__ == '__main__':
    rows, skipped = parse_all()
    print(f'parsed: {len(rows)}', file=sys.stderr)
    print(f'skipped: {skipped}', file=sys.stderr)
    if len(sys.argv) > 1 and sys.argv[1] == 'sample':
        for r in rows[:10] + rows[-5:]:
            print(r)
    elif len(sys.argv) > 1 and sys.argv[1] == 'sql':
        now = int(time.time())
        esc = lambda s: str(s).replace("'", "''")
        for r in rows:
            print(
                "INSERT INTO vehicles (make, model, year_start, year_end, variant, refrigerant, charge_g, notes, updated_at, source) VALUES "
                f"('{esc(r['make'])}', '{esc(r['model'])}', {r['year_start']}, {r['year_end']}, "
                f"'{esc(r['variant'])}', '{r['refrigerant']}', {r['charge_g']}, '{esc(r['notes'])}', {now}, 'nissens');"
            )

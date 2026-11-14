#!/usr/bin/env python3
"""Convert parsed GasBook rows to D1 INSERT statements."""
import sys, re, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_gasbook import parse_all

CURRENT_YEAR = 2026
MAX_YEAR = 2100

def parse_two_digit_year(yy):
    """Convert 2-digit year to 4-digit. Book covers vehicles 1950s-2014,
    so: 00-20 → 20XX, 21-99 → 19XX, >=1900 as-is."""
    y = int(yy)
    if y >= 1900:
        return y
    if y <= 20:
        return 2000 + y
    return 1900 + y

def parse_year_range(ys):
    """Return (year_start, year_end). Supported formats:
         88-92, 94-04, 01>, >92, 92>, 5/00-08, 11/97-00, 11/98-12/98, 2010-2013
    Returns None if unparseable.
    """
    ys = ys.strip()
    if not ys:
        return None
    # Normalise: strip leading '>' and trailing '>'
    open_ended_start = ys.endswith('>') and not ys.startswith('>')
    open_ended_before = ys.startswith('>')
    s = ys.strip('>').strip()
    # Split on '-' first (the most common case)
    if '-' in s:
        left, right = s.split('-', 1)
    else:
        left = right = s
    def take_year(frag):
        frag = frag.strip()
        if '/' in frag:
            # "5/00" or "11/98" — take after the slash (the year part)
            frag = frag.split('/', 1)[1]
        if not frag or not frag.isdigit():
            return None
        return parse_two_digit_year(frag)
    y1 = take_year(left)
    y2 = take_year(right)
    if y1 is None and y2 is None:
        return None
    if open_ended_before:
        # ">92" style — in this book means "92 onwards" (newer variant)
        return (y1 or y2, MAX_YEAR)
    if open_ended_start:
        # "01>" — 01 onwards
        return (y1, MAX_YEAR)
    if y1 is None:
        y1 = y2
    if y2 is None:
        y2 = y1
    if y2 < y1:
        # 2-digit year interpretation mistake: "99-01" → 1999-2001 not 1999-1901
        if y2 < 100:
            y2 = y2 + 100
    return (y1, y2)

def parse_charge(cs):
    """Return int grams. '450-475' → midpoint 462 (rounded to nearest 5g)."""
    cs = cs.strip()
    if '-' in cs:
        try:
            lo, hi = cs.split('-', 1)
            mid = (int(lo) + int(hi)) / 2
            return int(round(mid / 5) * 5)
        except ValueError:
            return None
    try:
        return int(cs)
    except ValueError:
        return None

def sql_escape(s):
    return s.replace("'", "''")

def extract_variant(model):
    """Pull out an engine-size/trim-style variant string from the model if any.
    Keep the main nameplate as `model`, move trailing details to `variant`.

    Examples:
      '145, 1.6, 1.7, 2.0Lt' → ('145', '1.6, 1.7, 2.0Lt')
      'GT, 3.0Lt V6'         → ('GT', '3.0Lt V6')
      'A4 (8K)'              → ('A4', '8K')
      '1 Series (E87), 125i, 130i' → ('1 Series', 'E87, 125i, 130i')
      'Hilux'                → ('Hilux', '')
    """
    m = re.match(r'^([^,(]+?)(?:\s*\(([^)]*)\))?(?:,\s*(.+))?$', model.strip())
    if not m:
        return (model.strip(), '')
    name = m.group(1).strip()
    bracket = (m.group(2) or '').strip()
    rest = (m.group(3) or '').strip()
    bits = [b for b in (bracket, rest) if b]
    return (name, ', '.join(bits))

def main():
    rows = parse_all()
    now = int(time.time())
    inserts = ["DELETE FROM vehicles;"]  # start clean
    skipped = []
    for r in rows:
        yr = parse_year_range(r['years'])
        ch = parse_charge(r['charge'])
        if not yr or ch is None:
            skipped.append(r)
            continue
        y1, y2 = yr
        model, variant = extract_variant(r['model'])
        # Merge original range + any parser notes into Notes
        extra_notes = []
        if '-' in r['charge']:
            extra_notes.append(f"range {r['charge']}g")
        if r['notes']:
            extra_notes.append(r['notes'])
        notes = '; '.join(extra_notes)
        # Collapse PDF em-dash / extra whitespace
        notes = re.sub(r'\s+', ' ', notes).strip()
        inserts.append(
            f"INSERT INTO vehicles (make, model, year_start, year_end, variant, refrigerant, charge_g, notes, updated_at) "
            f"VALUES ('{sql_escape(r['make'])}', '{sql_escape(model)}', {y1}, {y2}, '{sql_escape(variant)}', 'R134a', {ch}, '{sql_escape(notes)}', {now});"
        )
    print('\n'.join(inserts))
    print(f"-- rows written: {len(inserts) - 1}", file=sys.stderr)
    print(f"-- rows skipped: {len(skipped)}", file=sys.stderr)
    if skipped[:5]:
        print("-- sample skipped:", file=sys.stderr)
        for s in skipped[:5]:
            print(f"--   {s}", file=sys.stderr)

if __name__ == '__main__':
    main()

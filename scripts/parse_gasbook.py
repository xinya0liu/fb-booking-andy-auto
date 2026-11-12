#!/usr/bin/env python3
"""Parse CoolDrive GasBook2014 PDF (pages 7-64)."""
import pdfplumber, re, sys, json
from collections import Counter

PDF = '/Users/liuxinya/Downloads/GasBook2014Online.pdf'
CONTENT_FONT_RE = re.compile(r'HelveticaNeueLTStd', re.IGNORECASE)
YEAR_RE = re.compile(r'^>?\d{1,4}(?:/\d{1,2})?(?:-\d{1,4}(?:/\d{1,2})?)?>?$')
CHARGE_RE = re.compile(r'^\d{2,4}(?:-\d{2,4})?$')

# Whitelist of known car makes as they appear in the PDF. Anything else in the
# "no years/charge" state is a multi-line continuation, not a new make.
KNOWN_MAKES = {
    'Alfa Romeo', 'Aston Martin', 'Audi', 'BMW', 'Cadillac', 'Cherry', 'Chevrolet',
    'Chrysler (including Dodge)', 'Citroën', 'DAF - Truck', 'Daewoo',
    'Daewoo/Avia - Truck', 'Daihatsu', 'Eunos', 'Fiat', 'Ford', 'Great Wall',
    'Holden', 'Honda', 'Hummer', 'Hyundai', 'Infiniti', 'Isuzu', 'Iveco',
    'Iveco - Truck', 'Jaguar', 'Jeep', 'Kia', 'LDV', 'Lada', 'Lancia',
    'Land Rover (including Range Rover)', 'Lexus', 'Leyland', 'MAN - Truck',
    'Maybach', 'Mazda', 'Mercedes-Benz', 'Mercedes-Benz - Truck', 'MG', 'Mini',
    'Mitsubishi', 'Mitsubishi - Truck', 'Nissan', 'Nissan - Truck', 'Opel',
    'Peugeot', 'Pontiac', 'Porsche', 'Proton', 'Renault', 'Renault - Truck',
    'Rolls-Royce', 'Rover', 'SAAB', 'Scania - Truck', 'Seat', 'Škoda', 'Smart',
    'Ssangyong', 'Subaru', 'Suzuki', 'Tata', 'Toyota', 'Triumph', 'Volkswagen',
    'Volvo',
}

def extract_page(page):
    words = [w for w in page.extract_words(x_tolerance=1, y_tolerance=2,
             extra_attrs=['fontname'])
             if CONTENT_FONT_RE.search(w.get('fontname', ''))]
    rows_raw = []
    cur, cur_top = [], None
    for w in sorted(words, key=lambda w: (round(w['top']), w['x0'])):
        if cur_top is None or abs(w['top'] - cur_top) <= 2:
            cur.append(w); cur_top = w['top'] if cur_top is None else cur_top
        else:
            rows_raw.append(cur); cur = [w]; cur_top = w['top']
    if cur: rows_raw.append(cur)
    out = []
    for r in rows_raw:
        r = sorted(r, key=lambda w: w['x0'])
        texts = [w['text'] for w in r]
        if 'Vehicle,' in texts and 'Make' in texts:
            continue
        if len(r) == 1 and texts[0].isdigit() and len(texts[0]) <= 2:
            continue
        # Classify words
        charge_idx = year_idx = None
        for i in range(len(r) - 1, -1, -1):
            if CHARGE_RE.match(r[i]['text']) and 'BlkCn' in r[i].get('fontname', ''):
                charge_idx = i
                break
        search_end = charge_idx if charge_idx is not None else len(r)
        for i in range(search_end - 1, -1, -1):
            if YEAR_RE.match(r[i]['text']):
                year_idx = i
                break
        charge = r[charge_idx]['text'] if charge_idx is not None else ''
        years = r[year_idx]['text'] if year_idx is not None else ''
        rest = r[:year_idx] if year_idx is not None else (r[:charge_idx] if charge_idx is not None else r)
        model_words, notes_words = [], []
        if rest:
            groups = [[rest[0]]]
            for w in rest[1:]:
                if w['x0'] - groups[-1][-1]['x1'] > 30:
                    groups.append([])
                groups[-1].append(w)
            model_words = [w['text'] for w in groups[0]]
            for g in groups[1:]:
                notes_words.extend(w['text'] for w in g)
        out.append({
            'model': ' '.join(model_words).strip(),
            'notes': ' '.join(notes_words).strip(),
            'years': years,
            'charge': charge,
        })
    return out

def parse_all():
    results = []
    current_make = None
    pending_model = None  # for multi-line entries
    with pdfplumber.open(PDF) as pdf:
        for pnum in range(7, 65):
            page = pdf.pages[pnum - 1]
            for r in extract_page(page):
                if r['model'] in KNOWN_MAKES and not r['years'] and not r['charge']:
                    current_make = r['model']
                    pending_model = None
                    continue
                if not r['years'] and not r['charge']:
                    # "no years/charge" row that's not a make = multi-line model header
                    if r['model'] and len(r['model']) < 80:
                        pending_model = r['model']
                    continue
                if not r['years'] or not r['charge']:
                    continue
                # If model empty and we have a pending model from prior row, use it
                effective_model = r['model']
                effective_notes = r['notes']
                if pending_model:
                    if not effective_model:
                        effective_model = pending_model
                    else:
                        # pending_model is the group header, current model is a sub-variant → pack into notes
                        effective_notes = (effective_model + (' · ' + effective_notes if effective_notes else '')).strip()
                        effective_model = pending_model
                if effective_model and current_make:
                    results.append({
                        'make': current_make,
                        'model': effective_model,
                        'notes': effective_notes,
                        'years': r['years'],
                        'charge': r['charge'],
                    })
    return results

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'dump':
        start, end = int(sys.argv[2]), int(sys.argv[3])
        with pdfplumber.open(PDF) as pdf:
            for pnum in range(start, end + 1):
                print(f"=== page {pnum} ===")
                for r in extract_page(pdf.pages[pnum - 1]):
                    print(f"  {r}")
                print()
    elif len(sys.argv) > 1 and sys.argv[1] == 'json':
        rows = parse_all()
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    else:
        rows = parse_all()
        print(f"total: {len(rows)}\n")
        by_make = Counter(r['make'] for r in rows)
        for mk, n in sorted(by_make.items()):
            print(f"  {mk}: {n}")

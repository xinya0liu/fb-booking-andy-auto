#!/usr/bin/env python3
import sqlite3, json, datetime, time, threading, subprocess, re, os, sys, glob
import urllib.request, urllib.parse, urllib.error

DB = "/Users/andy/Library/Messages/chat.db"
WORKER = "https://fb-booking-andy-auto.susanna0liu.workers.dev"
SECRET = "andy-booking-2026"
KEYWORDS = {"booking confirmed", "booking updated", "booking cancelled"}
ROWID_FILE = "/Users/andy/imessage-service/last_rowid.txt"
PIDFILE   = "/Users/andy/imessage-service/server.pid"

def _acquire_pid_lock():
    if os.path.exists(PIDFILE):
        try:
            pid = int(open(PIDFILE).read().strip())
            os.kill(pid, 0)
            print(f"Already running (PID {pid}). Exiting.", flush=True)
            sys.exit(1)
        except (ProcessLookupError, ValueError, OSError):
            pass
    open(PIDFILE, 'w').write(str(os.getpid()))
    import atexit; atexit.register(lambda: os.path.exists(PIDFILE) and os.unlink(PIDFILE))

_acquire_pid_lock()

import signal
def _sigterm_handler(sig, frame):
    print("Received SIGTERM — shutting down cleanly.", flush=True)
    sys.exit(0)
signal.signal(signal.SIGTERM, _sigterm_handler)

def load_last_rowid():
    try:
        return int(open(ROWID_FILE).read().strip())
    except:
        return 0

def save_last_rowid(rowid):
    open(ROWID_FILE, "w").write(str(rowid))

_TS_SKIP = {
    b'streamtyped', b'NSMutableAttributedString', b'NSAttributedString',
    b'NSObject', b'NSMutableString', b'NSString', b'NSDictionary',
    b'__kIMMessagePartAttributeName', b'NSNumber', b'NSValue',
    b'NSColor', b'NSFont', b'NSParagraphStyle', b'NSMutableDictionary',
    b'NSArray', b'NSMutableArray', b'NSData', b'NSURL', b'NSDate',
}

def decode_text(text, attributed_body):
    """Return text, falling back to attributedBody (typedstream) for macOS Sonoma."""
    if text:
        return text
    if not attributed_body:
        return ''
    blob = attributed_body if isinstance(attributed_body, bytes) else bytes(attributed_body)
    try:
        from Foundation import NSData, NSUnarchiver
        data = NSData.dataWithBytes_length_(blob, len(blob))
        obj = NSUnarchiver.unarchiveObjectWithData_(data)
        if obj and hasattr(obj, 'string'):
            s = str(obj.string())
            if s:
                return s
    except Exception:
        pass
    if blob[:1] != b'\x04':
        return ''
    try:
        best = b''
        for s in re.findall(rb'[a-zA-Z][\x20-\x7e]{3,}', blob):
            if s in _TS_SKIP:
                continue
            if s.startswith(b'NS') or s.startswith(b'__k') or s.startswith(b'CF') or s.startswith(b'kIM'):
                continue
            if re.search(rb'\$[a-zA-Z]', s):  # plist metadata: $version, $archiver, $class
                continue
            if len(s) > len(best):
                best = s
        if best:
            return best.decode('utf-8', errors='replace')
    except Exception:
        pass
    return ''

def normalize_phone(phone):
    clean = phone.replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    core = clean
    if core.startswith("+61"): core = core[3:]
    elif core.startswith("61") and len(core) == 11: core = core[2:]
    elif core.startswith("0") and len(core) == 10: core = core[1:]
    return list({phone, clean, core, "0"+core, "61"+core, "+61"+core})

def to_e164(phone):
    clean = phone.replace(" ", "").replace("-", "")
    if clean.startswith("+"): return clean
    if clean.startswith("61"): return "+" + clean
    if clean.startswith("0"): return "+61" + clean[1:]
    return "+61" + clean

def query(phone):
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        cur = con.cursor()
        variants = normalize_phone(phone)
        handles = []
        for p in variants:
            cur.execute("SELECT ROWID FROM handle WHERE id LIKE ?", (f"%{p}%",))
            handles.extend(r[0] for r in cur.fetchall())
        handles = list(set(handles))
        chats = []
        if handles:
            ph = ",".join("?" * len(handles))
            cur.execute(f"SELECT DISTINCT chat_id FROM chat_handle_join WHERE handle_id IN ({ph})", handles)
            chats = [r[0] for r in cur.fetchall()]
        if not chats:
            # Fallback for SMS conversations that lack chat_handle_join entries
            for p in variants:
                cur.execute("SELECT ROWID FROM chat WHERE chat_identifier LIKE ?", (f"%{p}%",))
                chats = [r[0] for r in cur.fetchall()]
                if chats:
                    break
        if not chats:
            con.close()
            return []
        cp = ",".join("?" * len(chats))
        cur.execute(f"""
            SELECT m.text, m.is_from_me, m.date, m.attributedBody
            FROM message m
            JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
            WHERE cmj.chat_id IN ({cp})
            ORDER BY m.date DESC LIMIT 100
        """, chats)
        rows = cur.fetchall()
        con.close()
        msgs = []
        for text, from_me, ts, attributed_body in reversed(rows):
            content = decode_text(text, attributed_body)
            if not content:
                continue
            unix = ts / 1e9 + 978307200
            dt = datetime.datetime.fromtimestamp(unix).strftime("%m/%d %H:%M")
            label = "Us" if from_me else "Customer"
            msgs.append(f"[{dt}] {label}: {content}")
        return msgs
    except Exception as e:
        print(f"query error: {e}", flush=True)
        return []

def clean_contact_name(name):
    # Strip date/time prefix like "13/10 Monday 11pm" or "Monday 5pm"
    cleaned = re.sub(
        r'^(?:\d{1,2}/\d{1,2}\s+)?(?:mon|tue|wed|thu|fri|sat|sun)\w*\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)',
        '', name, flags=re.IGNORECASE
    ).strip()
    return cleaned

def get_contact_name(phone):
    digits = re.sub(r'[^\d]', '', phone)
    core = digits[-9:] if len(digits) >= 9 else digits
    if not core:
        return ''
    db_paths = glob.glob(os.path.expanduser(
        '~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb'
    ))
    for db_path in db_paths:
        try:
            con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            cur = con.cursor()
            cur.execute('''
                SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZNAME, p.ZFULLNUMBER
                FROM ZABCDPHONENUMBER p
                JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK
            ''')
            for first, last, zname, ph in cur.fetchall():
                ph_digits = re.sub(r'[^\d]', '', ph or '')
                if core in ph_digits:
                    parts = [x for x in [first, last] if x]
                    name = ' '.join(parts) or zname or ''
                    if name:
                        con.close()
                        return name
            con.close()
        except Exception:
            pass
    return ''

def send_imessage(phone, text, service='iMessage'):
    e164 = to_e164(phone)
    # AppleScript can't handle json \uXXXX or \n escapes — build string manually
    parts = [p.replace('"', '" & quote & "') for p in text.split('\n')]
    as_str = '" & return & "'.join(parts)
    svc_type = 'SMS' if service and service.upper() == 'SMS' else 'iMessage'
    script = f'''tell application "Messages"
        set svc to 1st service whose service type = {svc_type}
        send "{as_str}" to buddy "{e164}" of svc
    end tell'''
    subprocess.run(["osascript", "-e", script], check=True, timeout=30)

def scan_keywords():
    last_rowid = load_last_rowid()
    s = urllib.parse.quote(SECRET)
    while True:
        try:
            con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
            cur = con.cursor()
            cur.execute("""
                SELECT m.ROWID, COALESCE(m.text, ''), COALESCE(h.id, c.chat_identifier), m.attributedBody, COALESCE(m.service, c.service_name, 'iMessage')
                FROM message m
                JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                JOIN chat c ON cmj.chat_id = c.ROWID
                LEFT JOIN chat_handle_join chj ON cmj.chat_id = chj.chat_id
                LEFT JOIN handle h ON chj.handle_id = h.ROWID
                WHERE m.is_from_me = 1
                  AND m.ROWID > ?
                  AND (
                    lower(COALESCE(m.text, '')) LIKE '%booking confirmed%'
                    OR lower(COALESCE(m.text, '')) LIKE '%booking updated%'
                    OR lower(COALESCE(m.text, '')) LIKE '%booking cancelled%'
                    OR ((m.text IS NULL OR m.text = '') AND m.attributedBody IS NOT NULL)
                  )
                ORDER BY m.ROWID ASC
            """, (last_rowid,))
            rows = cur.fetchall()
            con.close()
            for rowid, sql_text, phone, attributed_body, service in rows:
                text = decode_text(sql_text, attributed_body).lower().strip()
                if not text:
                    last_rowid = max(last_rowid, rowid)
                    save_last_rowid(last_rowid)
                    continue
                if 'booking confirmed' in text:
                    action = 'confirmed'
                elif 'booking updated' in text:
                    action = 'updated'
                elif 'booking cancelled' in text:
                    action = 'cancelled'
                else:
                    last_rowid = max(last_rowid, rowid)
                    save_last_rowid(last_rowid)
                    continue
                # Save ROWID only after successful processing so crashes don't skip messages
                print(f"Keyword: {text} from {phone}", flush=True)
                msgs = query(phone)
                if not msgs:
                    print(f"No messages found for {phone}", flush=True)
                    last_rowid = max(last_rowid, rowid)
                    save_last_rowid(last_rowid)
                    continue
                contact_name = clean_contact_name(get_contact_name(phone))
                body = json.dumps({
                    "phone": phone,
                    "conversation": "\n".join(msgs),
                    "action": action,
                    "contact_name": contact_name,
                }).encode()
                req = urllib.request.Request(
                    f"{WORKER}/imessage-keyword?secret={s}",
                    data=body,
                    headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
                    method="POST"
                )
                try:
                    with urllib.request.urlopen(req, timeout=30) as r:
                        result = json.loads(r.read())
                        reply = result.get("reply", "")
                        if reply:
                            try:
                                send_imessage(phone, reply, service=service)
                                print(f"Replied to {phone} via {service}", flush=True)
                            except Exception as se:
                                print(f"SEND FAILED for {phone}: {se}\nReply was: {reply}", flush=True)
                except urllib.error.HTTPError as e:
                    # Worker returned 4xx/5xx — permanent failure, skip this message
                    print(f"Worker error {e.code} for {phone}: {e.read().decode('utf-8', errors='replace')[:200]}", flush=True)
                except urllib.error.URLError as e:
                    # Network error — stop this batch so later rows don't advance last_rowid past this message
                    print(f"Network error for {phone}, will retry: {e}", flush=True)
                    break
                last_rowid = max(last_rowid, rowid)
                save_last_rowid(last_rowid)
        except Exception as e:
            print(f"scan error: {e}", flush=True)
        time.sleep(5)

def poll():
    s = urllib.parse.quote(SECRET)
    while True:
        try:
            url = f"{WORKER}/imessage-poll?secret={s}"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
                phone = data.get("phone")
                if phone:
                    print(f"Task: {phone}", flush=True)
                    msgs = query(phone)
                    body = json.dumps({
                        "phone": phone,
                        "conversation": "\n".join(msgs) if msgs else ""
                    }).encode()
                    req = urllib.request.Request(
                        f"{WORKER}/imessage-result?secret={s}",
                        data=body,
                        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
                        method="POST"
                    )
                    urllib.request.urlopen(req, timeout=15)
                    print(f"Sent {len(msgs)} messages for {phone}", flush=True)
        except Exception as e:
            print(f"poll error: {e}", flush=True)
        time.sleep(5)

print("iMessage polling service started", flush=True)
threading.Thread(target=scan_keywords, daemon=True).start()
poll()

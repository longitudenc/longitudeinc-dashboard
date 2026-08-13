"""
market_ingest_ci.py — cloud version of append_market_week.py (weekly forward run only).

Runs in GitHub Actions right after market_compare_ci.py drops the CSV in ./downloads.
Joins salon coords from scripts/CLT Market Final.csv and POSTs one row per salon to
the dashboard's /api/market/ingest-weekly route (service-account write; no Google creds).

Env:  CRON_SECRET  (must match CRON_SECRET in Vercel)  [required]
      MARKET_COORDS (optional path to the coords CSV; defaults to scripts/CLT Market Final.csv)
"""
import os, re, csv, glob, json, sys, datetime as dt
import urllib.request, urllib.error

DOWNLOADS   = os.path.join(os.getcwd(), "downloads")
REPORT_GLOB = "MarketCompare*.csv"
COORDS_CSV  = os.environ.get("MARKET_COORDS", os.path.join(os.getcwd(), "scripts", "CLT Market Final.csv"))
INGEST_URL  = "https://longitudeinc-dashboard.vercel.app/api/market/ingest-weekly"
INGEST_SECRET = os.environ.get("CRON_SECRET")

HEADER = ["weekEnding", "salonNum", "name", "do", "lat", "lng",
          "cc", "ccLY", "sales", "serviceSales", "ccChg",
          "nr", "rr", "invoice", "serviceDisc", "product",
          "payroll", "waits", "ssWaits", "nonOciWaits", "cph",
          "mbc", "hcTime", "oci", "newCust",
          "regPrice", "csPrice", "avgEffWage", "voidPct"]

def last_friday(today=None):
    d = today or dt.date.today()
    return d - dt.timedelta(days=(d.weekday() - 4) % 7)

def load_coords():
    coords = {}
    if not os.path.exists(COORDS_CSV):
        print(f"::error:: coords file not found: {COORDS_CSV} — add it to the repo (scripts/CLT Market Final.csv). "
              "Posting without coords would erase existing lat/lng in MarketWeekly.")
        sys.exit(4)
    with open(COORDS_CSV, encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    hdr = [h.strip().lower() for h in rows[0]]
    def col(*names):
        for n in names:
            if n in hdr: return hdr.index(n)
        return None
    ci_lat, ci_lng = col("latitude", "lat"), col("longitude", "long", "lng")
    ci_salon = col("salon", "salon number", "salon name")
    if ci_lat is None or ci_lng is None or ci_salon is None:
        print("::error:: coords file missing lat/long/salon columns"); sys.exit(4)
    for r in rows[1:]:
        if ci_salon >= len(r): continue
        m = re.match(r"\s*(\d+)", str(r[ci_salon]))
        if not m: continue
        try: coords[m.group(1)] = (float(r[ci_lat]), float(r[ci_lng]))
        except Exception: pass
    print(f"[market-week] loaded coords for {len(coords)} salons")
    return coords

def latest_report():
    files = glob.glob(os.path.join(DOWNLOADS, REPORT_GLOB))
    if not files: raise FileNotFoundError(f"No {REPORT_GLOB} in {DOWNLOADS}")
    return max(files, key=os.path.getmtime)

def build_rows(week_ending):
    coords = load_coords()
    path = latest_report()
    print(f"[market-week] reading {os.path.basename(path)}")
    with open(path, encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    hdr = {h.strip(): i for i, h in enumerate(rows[0]) if h.strip()}
    def g(r, name):
        i = hdr.get(name)
        if i is None or i >= len(r): return None
        v = str(r[i]).strip()
        try: return float(v)
        except Exception: return v or None
    salon_col = hdr.get("Salons In My Market")
    out = []
    for r in rows[1:]:
        raw0 = (r[salon_col].strip() if (salon_col is not None and salon_col < len(r))
                else (r[0].strip() if r else ""))
        m = re.match(r"\s*(\d+)", raw0)
        if not m: continue
        sn = m.group(1)
        nm = raw0.split(":", 1)[1].strip() if ":" in raw0 else ""
        nm = re.sub(r"\.\.\.$", "", nm).strip()
        do_full = g(r, "Designated Operator")
        dm = re.match(r"[A-Za-z]+", str(do_full or "").strip())
        do = dm.group(0) if dm else ""
        latlng = coords.get(sn, (None, None))
        def pct(k):
            v = g(r, k); return round(v * 100, 4) if isinstance(v, float) else ""
        def num(k):
            v = g(r, k); return v if isinstance(v, float) else ""
        rec = {
            "weekEnding": week_ending.isoformat(), "salonNum": sn, "name": nm, "do": do,
            "lat": latlng[0] if latlng[0] is not None else "",
            "lng": latlng[1] if latlng[1] is not None else "",
            "cc": num("Cust Count This Year"), "ccLY": num("Cust Count Last Year"),
            "sales": num("Total Sales This Year"), "serviceSales": num("Service Sales This Year"),
            "ccChg": pct("Cust Count Growth %"),
            "nr": pct("New Cust Return %"), "rr": pct("Repeat Cust Return %"),
            "invoice": num("Avg Invoice"), "serviceDisc": pct("Service Discount %"),
            "product": pct("Standard Prod %"),
            "payroll": pct("Payroll %"), "waits": pct("Waits > 15 Min %"),
            "ssWaits": pct("Sat/Sun Wait > 15 Min %"), "nonOciWaits": pct("Non-OCI Waits > 15 Min %"),
            "cph": num("Cuts Per Hour"), "mbc": num("Avg Mins Btwn Cust w/Cust Wtg"),
            "hcTime": num("Avg HC Time"),
            "oci": pct("% OCI and Served"), "newCust": pct("New Cust %"),
            "regPrice": num("Regular Haircut Price"), "csPrice": num("Child/Senior Haircut Price"),
            "avgEffWage": num("Avg Eff Wage"), "voidPct": pct("Void %"),
        }
        out.append([rec.get(h, "") for h in HEADER])
    return out

def post_rows(week, rows):
    if not rows:
        print("::error:: 0 rows parsed — nothing to post (check the CSV format)"); sys.exit(5)
    payload = json.dumps({"weekEnding": week.isoformat(), "columns": HEADER, "rows": rows}).encode("utf-8")
    req = urllib.request.Request(INGEST_URL, data=payload, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {INGEST_SECRET}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            print(f"::notice:: ingest {resp.status}: {resp.read().decode('utf-8')}")
    except urllib.error.HTTPError as e:
        print(f"::error:: ingest FAILED {e.code}: {e.read().decode('utf-8','replace')}"); sys.exit(6)
    except urllib.error.URLError as e:
        print(f"::error:: ingest FAILED (network): {e}"); sys.exit(6)

if __name__ == "__main__":
    if not INGEST_SECRET:
        print("::error:: CRON_SECRET secret is not set"); sys.exit(2)
    week = last_friday()
    print(f"[market-week] week ending {week.isoformat()}")
    rows = build_rows(week)
    print(f"[market-week] built {len(rows)} rows; posting...")
    post_rows(week, rows)

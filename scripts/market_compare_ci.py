"""
market_compare_ci.py — headless, cloud version of market_compare_report.py.

Runs on a GitHub Actions ubuntu runner (no laptop). Logs into myreports.greatclips.com,
runs "Market Compare CLT", exports CSV, and saves it to ./downloads. Prints verbose
diagnostics + a screenshot on failure so a workflow_dispatch test tells us immediately
whether MyReports allows a headless cloud login.

Env (GitHub secrets): MYREPORTS_USERNAME, MYREPORTS_PASSWORD
Selenium 4 auto-manages the driver (Selenium Manager) — no webdriver-manager needed.
"""
import os, sys, time
from datetime import date, timedelta
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select

DOWNLOAD = os.path.join(os.getcwd(), "downloads")
os.makedirs(DOWNLOAD, exist_ok=True)
REPORT_NAME = "Market Compare CLT"

user = os.environ.get("MYREPORTS_USERNAME")
pw   = os.environ.get("MYREPORTS_PASSWORD")
if not user or not pw:
    print("::error:: MYREPORTS_USERNAME / MYREPORTS_PASSWORD secrets are not set"); sys.exit(2)

last_friday = date.today() - timedelta(days=1)
out_name = f"MarketCompare{last_friday.strftime('%m%d%y')}.csv"

opts = webdriver.ChromeOptions()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-dev-shm-usage")
opts.add_argument("--disable-gpu")
opts.add_argument("--window-size=1500,1100")
opts.add_argument("--disable-blink-features=AutomationControlled")
opts.add_experimental_option("excludeSwitches", ["enable-automation"])
opts.add_experimental_option("useAutomationExtension", False)
opts.add_experimental_option("prefs", {
    "download.default_directory": DOWNLOAD,
    "download.prompt_for_download": False,
    "download.directory_upgrade": True,
    "safebrowsing.enabled": True,
})
driver = webdriver.Chrome(options=opts)
driver.set_page_load_timeout(90)

def shot(name):
    try: driver.save_screenshot(os.path.join(os.getcwd(), name)); print(f"  (saved {name})")
    except Exception: pass

try:
    # headless download + de-Headless the UA (some sites block "HeadlessChrome")
    driver.execute_cdp_cmd("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": DOWNLOAD})
    ua = driver.execute_script("return navigator.userAgent").replace("HeadlessChrome", "Chrome")
    driver.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": ua})

    print("Opening MyReports login...")
    driver.get("https://myreports.greatclips.com/")
    time.sleep(6)
    print("  login page title:", repr(driver.title), "| url:", driver.current_url)
    shot("01_login.png")

    driver.find_element(By.ID, "username").send_keys(user)
    driver.find_element(By.ID, "password").send_keys(pw)
    driver.find_element(By.ID, "button-login").click()
    print("Submitted login, waiting...")
    time.sleep(10)
    print("  after-login title:", repr(driver.title), "| url:", driver.current_url)
    shot("02_after_login.png")

    # Confirm login by content, not URL — MyReports keeps the same URL and leaves a
    # hidden login button in the DOM, so those are false signals. The real proof of a
    # logged-in session is the "Welcome," greeting and the report table rows.
    body_text = driver.find_element(By.TAG_NAME, "body").text
    rows = driver.find_elements(By.CSS_SELECTOR, "td.sorting_1")
    logged_in = ("Welcome," in body_text) or (len(rows) > 0)
    if not logged_in:
        print("::error:: Login not confirmed — no 'Welcome,' greeting and no report rows.")
        print("  page text sample:\n", body_text[:600])
        sys.exit(3)
    print(f"Logged in \u2713  Report rows found: {len(rows)}")
    names = [r.text for r in rows][:25]
    print("  report names:", names)

    clicked = False
    for row in rows:
        if row.text == REPORT_NAME:
            run_button = row.find_element(By.XPATH, "following-sibling::td//div[@class='report-bottons run']")
            run_button.click()
            print(f"'{REPORT_NAME}' clicked")
            clicked = True
            break
    if not clicked:
        print(f"::error:: report '{REPORT_NAME}' not found. See report names above.")
        shot("03_reportlist.png"); sys.exit(4)

    print("Waiting for report to load...")
    time.sleep(35)
    shot("04_report.png")

    export_icon = driver.find_element(By.CSS_SELECTOR, "i.gc-icon-filter-export-as")
    driver.execute_script("arguments[0].click();", export_icon)
    time.sleep(5)
    Select(driver.find_element(By.CSS_SELECTOR, "select.subgroup-ajax")).select_by_value("CSV")
    time.sleep(3)
    driver.execute_script("arguments[0].click();", driver.find_element(By.ID, "mr-export-run"))
    print("Export clicked, waiting for download...")

    got = None
    t0 = time.time()
    while time.time() - t0 < 150:
        fresh = [f for f in os.listdir(DOWNLOAD) if f.lower().endswith(".csv") and not f.endswith(".crdownload")]
        if fresh:
            fresh.sort(key=lambda f: os.path.getmtime(os.path.join(DOWNLOAD, f)), reverse=True)
            got = fresh[0]; break
        time.sleep(2)

    if not got:
        print("::error:: No CSV downloaded within 150s."); shot("05_nodownload.png"); sys.exit(5)

    src = os.path.join(DOWNLOAD, got); dst = os.path.join(DOWNLOAD, out_name)
    if os.path.exists(dst): os.remove(dst)
    os.rename(src, dst)
    n = sum(1 for _ in open(dst, encoding="utf-8", errors="ignore")) - 1
    print(f"::notice:: SUCCESS — downloaded {out_name} with ~{n} data rows.")
finally:
    driver.quit()

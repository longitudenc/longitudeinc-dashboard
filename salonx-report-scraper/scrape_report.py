#!/usr/bin/env python3
"""
Salon X Store (Great Clips / WooCommerce) — monthly Order Summary export + email.

Headless: logs into WordPress with requests (no browser), downloads the
"Export Order Summary" report from the my-account Orders page, and emails it
as an attachment.

The export endpoint is a WooCommerce/WordPress form POST to:
  https://salonxstore.greatclips.com/wp-content/themes/shop-isle-child/atomic/download.php

It requires an authenticated WordPress session cookie, which we obtain by
posting credentials to wp-login.php.

All secrets/config come from environment variables (see README). Nothing is
hardcoded except non-sensitive defaults.
"""

from __future__ import annotations

import base64
import calendar
import json
import os
import re
import sys
from datetime import date, datetime
from email.message import EmailMessage
from email.utils import formatdate
from html.parser import HTMLParser
from urllib.parse import urljoin
import smtplib

import requests

# --------------------------------------------------------------------------- #
# Configuration (env-driven)
# --------------------------------------------------------------------------- #

BASE_URL = os.environ.get("SALONX_BASE_URL", "https://salonxstore.greatclips.com").rstrip("/")
LOGIN_URL = f"{BASE_URL}/wp-login.php"
ORDERS_URL = f"{BASE_URL}/my-account/orders/"
DOWNLOAD_URL = f"{BASE_URL}/wp-content/themes/shop-isle-child/atomic/download.php"

# Which report to pull. Orders page offers:
#   "Export Order Summary"  (default)
#   "Export Order Details"
EXPORT_TYPE = os.environ.get("SALONX_EXPORT_TYPE", "Export Order Summary")

# Report filters (see README for allowed values).
SORT = os.environ.get("SALONX_SORT", "OrderDate_Desc")
STATUS = os.environ.get("SALONX_STATUS", "")  # "" = All

# Date-window mode. Orders auto-generate on the 15th and this runs on the 16th,
# so "current_month" captures that batch (1st of this month -> today).
#   current_month | last_month | trailing_30 | all | custom
DATE_MODE = os.environ.get("SALONX_DATE_MODE", "current_month")

USER_AGENT = os.environ.get(
    "SALONX_USER_AGENT",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
)

REQUEST_TIMEOUT = int(os.environ.get("SALONX_TIMEOUT", "60"))


def _require(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"ERROR: required environment variable {name} is not set.")
    return val


# --------------------------------------------------------------------------- #
# Date window
# --------------------------------------------------------------------------- #

def compute_date_window(today: date | None = None) -> tuple[str, str]:
    """Return (MinDate, MaxDate) as YYYY-MM-DD strings for the HTML date inputs.

    Empty strings mean "no bound" (server treats as unbounded)."""
    today = today or date.today()

    if DATE_MODE == "all":
        return "", ""

    if DATE_MODE == "trailing_30":
        from datetime import timedelta
        return (today - timedelta(days=30)).isoformat(), today.isoformat()

    if DATE_MODE == "custom":
        return os.environ.get("SALONX_MIN_DATE", ""), os.environ.get("SALONX_MAX_DATE", "")

    if DATE_MODE == "last_month":
        first_this = today.replace(day=1)
        from datetime import timedelta
        last_prev = first_this - timedelta(days=1)
        first_prev = last_prev.replace(day=1)
        return first_prev.isoformat(), last_prev.isoformat()

    # default: current_month  (1st of this month -> today)
    first = today.replace(day=1)
    last_day = calendar.monthrange(today.year, today.month)[1]
    end = today.replace(day=min(today.day, last_day))
    return first.isoformat(), end.isoformat()


# --------------------------------------------------------------------------- #
# Auth + download
# --------------------------------------------------------------------------- #

def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    return s


def wp_login(session: requests.Session, username: str, password: str) -> None:
    """Authenticate against the site's own wp-login.php form (the plain
    username/password box beneath the blue INsite button). Parses the real
    #loginform so any hidden fields (nonces, security-plugin tokens) ride along.
    Raises on failure. One attempt only."""
    r = session.get(LOGIN_URL, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    session.cookies.set("wordpress_test_cookie", "WP Cookie check", domain=_cookie_domain())

    # Find the WordPress login form (has both log + pwd fields).
    form = None
    for f in _parse_forms(r.text):
        if _key_ci(f["fields"], "log") and _key_ci(f["fields"], "pwd"):
            form = f
            break
    data = dict(form["fields"]) if form else {}
    data[_key_ci(data, "log") or "log"] = username
    data[_key_ci(data, "pwd") or "pwd"] = password
    data[_key_ci(data, "wp-submit") or "wp-submit"] = "Log In"
    data["redirect_to"] = ORDERS_URL
    data["testcookie"] = "1"
    action = urljoin(r.url, form["action"]) if (form and form.get("action")) else LOGIN_URL

    resp = session.post(
        action, data=data, headers={"Referer": r.url},
        timeout=REQUEST_TIMEOUT, allow_redirects=True,
    )
    resp.raise_for_status()

    # A successful login sets a wordpress_logged_in_* cookie.
    if not any(c.name.startswith("wordpress_logged_in") for c in session.cookies):
        msg = _extract_login_error(resp.text)
        sys.exit(
            "ERROR: WordPress login failed. " + (msg + " " if msg else "") +
            "If this account only accepts the blue INsite (SSO) button, the plain "
            "form won't work and we'll need a browser-based login or SALONX_COOKIE."
        )


class _FormParser(HTMLParser):
    """Collect every <form> on a page with its action, method, and input fields."""

    def __init__(self):
        super().__init__()
        self.forms = []
        self._cur = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self._cur = {"action": a.get("action", ""), "method": (a.get("method") or "get").lower(), "fields": {}}
            self.forms.append(self._cur)
        elif tag in ("input", "button", "select") and self._cur is not None:
            name = a.get("name")
            if name:
                self._cur["fields"][name] = a.get("value", "")

    def handle_endtag(self, tag):
        if tag == "form":
            self._cur = None


def _parse_forms(html: str):
    p = _FormParser()
    try:
        p.feed(html)
    except Exception:
        pass
    return p.forms


def _key_ci(d: dict, name: str):
    """Return the actual key in d matching name case-insensitively, else None."""
    low = name.lower()
    for k in d:
        if k.lower() == low:
            return k
    return None


def _find_sso_authorize_url(html: str):
    """Find the 'Login with Insite' ADFS authorize link on wp-login.php."""
    for m in re.finditer(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.I | re.S):
        href, text = m.group(1), m.group(2)
        if "adfs/oauth2/authorize" in href or re.search(r"insite|single sign|sso", text, re.I):
            return href.replace("&amp;", "&")
    m = re.search(r'href=["\']([^"\']*adfs/oauth2/authorize[^"\']*)["\']', html, re.I)
    return m.group(1).replace("&amp;", "&") if m else None


def _extract_adfs_error(html: str):
    for pat in (r'id=["\']errorText["\'][^>]*>(.*?)<', r'class=["\'][^"\']*error[^"\']*["\'][^>]*>(.*?)<'):
        m = re.search(pat, html, re.I | re.S)
        if m and m.group(1).strip():
            return re.sub(r"\s+", " ", m.group(1)).strip()[:200]
    return None


def _follow_auto_post(session: requests.Session, resp, max_hops: int = 5):
    """Auto-submit intermediate SSO continuation forms (OIDC/SAML POST-back).

    Stops once the WordPress session cookie is set, or no continuation form
    remains. Never resubmits a form containing a Password field (that would be
    the login form itself)."""
    for _ in range(max_hops):
        if any(c.name.startswith("wordpress_logged_in") for c in session.cookies):
            return resp
        forms = _parse_forms(resp.text)
        cont = None
        for f in forms:
            names = {k.lower() for k in f["fields"]}
            if "password" in names:
                continue  # don't re-post credentials
            if f["fields"]:  # a hidden auto-post form (wa/wresult/code/id_token/state)
                cont = f
                break
        if not cont:
            return resp
        action = urljoin(resp.url, cont["action"] or resp.url)
        resp = session.post(action, data=cont["fields"], headers={"Referer": resp.url},
                            timeout=REQUEST_TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
    return resp


def sso_login(session: requests.Session, username: str, password: str) -> None:
    """Log in through Great Clips ADFS OAuth2 SSO ('Login with Insite').

    Single credential attempt only — on failure it exits without retrying, to
    avoid tripping ADFS extranet lockout on the corporate AD account.
    """
    # 1. Load wp-login and locate the SSO authorize URL (carries the OAuth
    #    client_id/redirect_uri/state/nonce generated by the WP SSO plugin).
    r = session.get(LOGIN_URL, timeout=REQUEST_TIMEOUT, allow_redirects=True)
    r.raise_for_status()
    authorize = _find_sso_authorize_url(r.text)
    if not authorize:
        sys.exit("ERROR: couldn't find the 'Login with Insite' SSO link on the login page. "
                 "The login layout may have changed; use SALONX_COOKIE mode instead.")
    authorize = urljoin(r.url, authorize)

    # 2. Load the ADFS sign-in form.
    r = session.get(authorize, timeout=REQUEST_TIMEOUT, allow_redirects=True)
    r.raise_for_status()
    login_form = None
    for f in _parse_forms(r.text):
        if _key_ci(f["fields"], "UserName") and _key_ci(f["fields"], "Password"):
            login_form = f
            break
    if not login_form:
        # Diagnostic dump: shows where the SSO flow actually landed so we can tell
        # a JS-rendered / MFA / IP-block page apart from a simple form change.
        forms = _parse_forms(r.text)
        print("---- SSO DIAGNOSTIC ----")
        print("final URL :", r.url)
        print("status    :", r.status_code)
        _t = re.search(r"<title[^>]*>(.*?)</title>", r.text, re.I | re.S)
        print("page title:", (_t.group(1).strip()[:160] if _t else "(none)"))
        print("forms found:", len(forms))
        for i, f in enumerate(forms):
            print(f"  form[{i}] action={f.get('action')!r} fields={list(f['fields'].keys())[:25]}")
        _txt = re.sub(r"<script.*?</script>", " ", r.text, flags=re.S | re.I)
        _txt = re.sub(r"<style.*?</style>", " ", _txt, flags=re.S | re.I)
        _txt = re.sub(r"<[^>]+>", " ", _txt)
        _txt = re.sub(r"\s+", " ", _txt).strip()
        print("text preview:", _txt[:600])
        print("html length :", len(r.text))
        print("------------------------")
        sys.exit("ERROR: ADFS sign-in form not found. See diagnostic above. If SSO now "
                 "requires MFA or a different flow, switch to SALONX_COOKIE mode.")

    # 3. Fill credentials (one attempt).
    data = dict(login_form["fields"])
    data[_key_ci(data, "UserName")] = username
    data[_key_ci(data, "Password")] = password
    kmsi = _key_ci(data, "Kmsi")
    if kmsi:
        data[kmsi] = "true"  # "keep me signed in" -> longer session
    action = urljoin(r.url, login_form["action"] or r.url)

    r = session.post(action, data=data, headers={"Referer": r.url},
                     timeout=REQUEST_TIMEOUT, allow_redirects=True)
    r.raise_for_status()

    # 4. Follow the OAuth code / auto-post back to WordPress.
    r = _follow_auto_post(session, r)

    # 5. Confirm the WordPress session cookie landed.
    if not any(c.name.startswith("wordpress_logged_in") for c in session.cookies):
        err = _extract_adfs_error(r.text)
        detail = f"ADFS said: {err}. " if err else "SSO did not complete (no session cookie set). "
        sys.exit("ERROR: SSO login failed. " + detail +
                 "NOT retrying, to avoid locking the corporate AD account. "
                 "Verify MYREPORTS_USERNAME / MYREPORTS_PASSWORD, or use SALONX_COOKIE.")


def browser_login(session: requests.Session, username: str, password: str) -> None:
    """Log in with a real headless browser (Playwright): open the login page,
    click the blue INsite (SSO) button, sign in on the Great Clips ADFS page,
    then hand the resulting WordPress session cookies to the requests session.

    SAFETY: submits the password EXACTLY ONCE and never retries, so a wrong or
    stale password can't trip corporate AD extranet lockout. On any failure it
    raises without re-attempting.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("ERROR: browser mode needs Playwright. Add it to requirements.txt "
                 "and run 'python -m playwright install --with-deps chromium'.")

    def _fill_first(page, selectors, value):
        for sel in selectors:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    el.fill(value)
                    return True
            except Exception:
                continue
        return False

    def _click_first(page, selectors):
        for sel in selectors:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    el.click()
                    return True
            except Exception:
                continue
        return False

    cookies = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(user_agent=USER_AGENT)
        page = ctx.new_page()
        page.set_default_timeout(45000)

        print("  browser: loading login page")
        page.goto(LOGIN_URL, wait_until="domcontentloaded")

        print("  browser: clicking the INsite (SSO) button")
        if not _click_first(page, ["a[href*='adfs/oauth2/authorize']",
                                   "a.button-primary", "a.button-large"]):
            # fall back to navigating the authorize link directly
            link = page.query_selector("a[href*='adfs/oauth2/authorize']")
            if link:
                page.goto(link.get_attribute("href"), wait_until="domcontentloaded")
            else:
                browser.close()
                sys.exit("ERROR: couldn't find the INsite/SSO login button on the page.")

        # Wait for the ADFS sign-in fields to render.
        print("  browser: waiting for the sign-in form")
        page.wait_for_selector(
            "#userNameInput, input[name='UserName'], input[type='email'], input[name='Password'], #passwordInput",
            timeout=45000,
        )

        # Classic Great Clips ADFS shows username + password on ONE page.
        got_u = _fill_first(page, ["#userNameInput", "input[name='UserName']",
                                   "input[type='email']", "input[name='username']"], username)
        got_p = _fill_first(page, ["#passwordInput", "input[name='Password']",
                                   "input[type='password']"], password)
        if not (got_u and got_p):
            browser.close()
            sys.exit("ERROR: ADFS sign-in fields not found (layout may have changed, "
                     "or it's a multi-step / MFA flow). Not submitting credentials.")

        # ONE submit. No retry.
        print("  browser: submitting credentials (single attempt)")
        _click_first(page, ["#submitButton", "span#submitButton", "input[type='submit']",
                            "button[type='submit']", "#submit"])

        # Wait to land back on the store (OAuth code -> WP session).
        try:
            page.wait_for_url("**salonxstore.greatclips.com/**", timeout=60000)
        except Exception:
            pass
        # Confirm by loading the Orders page inside the browser.
        page.goto(ORDERS_URL, wait_until="domcontentloaded")
        cookies = ctx.cookies()
        browser.close()

    # Hand the browser's cookies to the requests session.
    for c in cookies:
        try:
            session.cookies.set(c["name"], c["value"],
                                domain=(c.get("domain") or "").lstrip("."),
                                path=c.get("path", "/"))
        except Exception:
            continue
    if not any(cn.name.startswith("wordpress_logged_in") for cn in session.cookies):
        sys.exit("ERROR: browser SSO login did not produce a WordPress session "
                 "(no wordpress_logged_in cookie). Not retrying. Verify the "
                 "MYREPORTS_USERNAME / MYREPORTS_PASSWORD secrets.")
    print("  browser: SSO login succeeded, session cookies captured")


def apply_cookie_header(session: requests.Session, cookie_header: str) -> None:
    """Cookie-reuse mode: load a browser session cookie instead of logging in.

    Bypasses the login page entirely (and therefore any Wordfence reCAPTCHA / 2FA
    / login-IP checks). Accepts a raw Cookie header string copied from the browser,
    e.g. "wordpress_logged_in_abc=trey%7C...; wordpress_sec_abc=...".
    """
    domain = _cookie_domain()
    pairs = [p.strip() for p in cookie_header.split(";") if "=" in p]
    for pair in pairs:
        name, _, value = pair.partition("=")
        session.cookies.set(name.strip(), value.strip(), domain=domain, path="/")
    if not any(c.name.startswith("wordpress_logged_in") for c in session.cookies):
        print("WARNING: SALONX_COOKIE has no 'wordpress_logged_in_*' cookie — "
              "the export may be rejected. Copy the full cookie string for the site.")


def verify_authenticated(session: requests.Session) -> None:
    """Confirm the session is actually logged in by loading the Orders page.

    In cookie mode there's no login response to check, so this catches an
    expired/incomplete cookie early with a clear message."""
    resp = session.get(ORDERS_URL, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    # Logged-out WooCommerce my-account shows the login form (name="username")
    # instead of the orders table / CurrentUserID field.
    if "CurrentUserID" not in resp.text and re.search(r'name=["\']username["\']', resp.text, re.I):
        sys.exit("ERROR: not authenticated — the session cookie appears expired or "
                 "incomplete. Refresh SALONX_COOKIE from your browser, or use "
                 "SALONX_USERNAME/SALONX_PASSWORD login.")


def _cookie_domain() -> str:
    return re.sub(r"^https?://", "", BASE_URL).split("/")[0]


def _extract_login_error(html: str) -> str:
    m = re.search(r'id="login_error"[^>]*>(.*?)</div>', html, re.S | re.I)
    if m:
        return re.sub(r"<[^>]+>", " ", m.group(1)).strip()[:200]
    return "Check SALONX_USERNAME / SALONX_PASSWORD, and whether the login page uses a CAPTCHA."


def get_current_user_id(session: requests.Session) -> str:
    """Parse the CurrentUserID hidden field from the Orders page (robust vs hardcoding)."""
    override = os.environ.get("SALONX_USER_ID")
    if override:
        return override
    resp = session.get(ORDERS_URL, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    m = re.search(r'name=["\']CurrentUserID["\']\s+[^>]*value=["\'](\d+)["\']', resp.text, re.I)
    if not m:
        m = re.search(r'value=["\'](\d+)["\']\s+name=["\']CurrentUserID["\']', resp.text, re.I)
    if not m:
        sys.exit("ERROR: could not find CurrentUserID on the Orders page — login may have failed "
                 "or the page layout changed. Set SALONX_USER_ID to override.")
    return m.group(1)


def download_report(session: requests.Session, user_id: str) -> tuple[bytes, str, str]:
    """POST the export form; return (content, filename, content_type)."""
    min_date, max_date = compute_date_window()
    form = {
        "CurrentUserID": user_id,
        "MinDate": min_date,
        "MaxDate": max_date,
        "Sort": SORT,
        "Status": STATUS,
        "Export": EXPORT_TYPE,
    }
    resp = session.post(
        DOWNLOAD_URL,
        data=form,
        headers={"Referer": ORDERS_URL},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()

    ctype = resp.headers.get("Content-Type", "application/octet-stream")
    # If we got HTML back, the export failed (usually an expired/blocked session).
    if "text/html" in ctype.lower():
        sys.exit("ERROR: export returned HTML instead of a file — the session was likely "
                 "rejected. Verify credentials and that the account can reach the Orders export.")

    filename = _filename_from_disposition(resp.headers.get("Content-Disposition"))
    if not filename:
        ext = "csv" if "csv" in ctype.lower() else ("xlsx" if "sheet" in ctype.lower() else "dat")
        filename = f"order_summary_{date.today():%Y_%m}.{ext}"
    return resp.content, filename, ctype


def _filename_from_disposition(cd: str | None) -> str | None:
    if not cd:
        return None
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd, re.I)
    return m.group(1).strip() if m else None


# --------------------------------------------------------------------------- #
# Email
# --------------------------------------------------------------------------- #

def _email_meta(filename: str):
    """Shared subject/body/recipients for whichever transport we use."""
    email_from = os.environ.get("EMAIL_FROM", "Longitude Reports <noreply@mail.longitudenc.com>")
    recipients = [a.strip() for a in _require("EMAIL_TO").split(",") if a.strip()]
    month_label = f"{date.today():%B %Y}"
    subject = os.environ.get("EMAIL_SUBJECT", f"Salon X Order Summary \u2014 {month_label}")
    body = os.environ.get(
        "EMAIL_BODY",
        f"Attached is the automated Salon X Store Order Summary for {month_label}.\n\n"
        f"Report: {EXPORT_TYPE}\nFile: {filename}\n\n"
        f"This message was generated automatically.",
    )
    return email_from, recipients, subject, body


def _send_email_resend(content: bytes, filename: str, content_type: str) -> None:
    """Email the report via the Resend API — the same service the dashboard uses.

    Config: RESEND_API_KEY (required), EMAIL_FROM (default the verified
    noreply@mail.longitudenc.com sender), EMAIL_TO, EMAIL_SUBJECT, EMAIL_BODY.
    """
    api_key = _require("RESEND_API_KEY")
    email_from, recipients, subject, body = _email_meta(filename)
    payload = {
        "from": email_from,
        "to": recipients,
        "subject": subject,
        "text": body,
        "attachments": [{
            "filename": filename,
            "content": base64.b64encode(content).decode("ascii"),
        }],
    }
    resp = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        data=json.dumps(payload),
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code >= 300:
        raise SystemExit(f"Resend send failed ({resp.status_code}): {resp.text[:500]}")
    print(f"Emailed '{filename}' ({len(content)} bytes) to {', '.join(recipients)} via Resend")


def send_email(content: bytes, filename: str, content_type: str) -> None:
    """Dispatch to Resend (preferred, matches the dashboard) or SMTP fallback."""
    if os.environ.get("RESEND_API_KEY"):
        _send_email_resend(content, filename, content_type)
    elif os.environ.get("SMTP_HOST"):
        _send_email_smtp(content, filename, content_type)
    else:
        raise SystemExit(
            "No email transport configured. Set RESEND_API_KEY (recommended) "
            "or the SMTP_* variables."
        )


def _send_email_smtp(content: bytes, filename: str, content_type: str) -> None:
    """Email the report as an attachment via SMTP (fallback).

    Configure via env:
      SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASSWORD,
      SMTP_STARTTLS ("1"/"0", default 1), SMTP_SSL ("1"/"0", default 0),
      EMAIL_FROM, EMAIL_TO (comma-separated), EMAIL_SUBJECT, EMAIL_BODY.
    """
    host = _require("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASSWORD")
    use_ssl = os.environ.get("SMTP_SSL", "0") == "1"
    use_starttls = os.environ.get("SMTP_STARTTLS", "1") == "1"

    email_from = os.environ.get("EMAIL_FROM", user or "")
    email_to = _require("EMAIL_TO")
    recipients = [addr.strip() for addr in email_to.split(",") if addr.strip()]

    month_label = f"{date.today():%B %Y}"
    subject = os.environ.get("EMAIL_SUBJECT", f"Salon X Order Summary — {month_label}")
    body = os.environ.get(
        "EMAIL_BODY",
        f"Attached is the automated Salon X Store Order Summary for {month_label}.\n\n"
        f"Report: {EXPORT_TYPE}\nFile: {filename}\n\n"
        f"This message was generated automatically.",
    )

    msg = EmailMessage()
    msg["From"] = email_from
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(body)

    maintype, _, subtype = content_type.partition("/")
    subtype = (subtype or "octet-stream").split(";")[0].strip() or "octet-stream"
    if maintype not in ("application", "text", "image"):
        maintype = "application"
    msg.add_attachment(content, maintype=maintype, subtype=subtype, filename=filename)

    if use_ssl:
        server = smtplib.SMTP_SSL(host, port, timeout=REQUEST_TIMEOUT)
    else:
        server = smtplib.SMTP(host, port, timeout=REQUEST_TIMEOUT)
    try:
        server.ehlo()
        if use_starttls and not use_ssl:
            server.starttls()
            server.ehlo()
        if user and password:
            server.login(user, password)
        server.send_message(msg, from_addr=email_from, to_addrs=recipients)
    finally:
        server.quit()

    print(f"Emailed '{filename}' ({len(content)} bytes) to {', '.join(recipients)}")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> int:
    session = make_session()
    cookie_header = os.environ.get("SALONX_COOKIE")

    # Auth mode: adfs (default, Great Clips SSO) | wordpress | cookie.
    # SALONX_COOKIE always takes priority if provided.
    auth_mode = os.environ.get("SALONX_AUTH_MODE", "adfs").lower()

    if cookie_header:
        print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] Using SALONX_COOKIE session (no login) ...")
        apply_cookie_header(session, cookie_header)
        verify_authenticated(session)
    elif auth_mode == "browser":
        username = _require("SALONX_USERNAME")
        password = _require("SALONX_PASSWORD")
        print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] Browser SSO login (Insite) to {BASE_URL} ...")
        browser_login(session, username, password)
        verify_authenticated(session)
    elif auth_mode == "wordpress":
        username = _require("SALONX_USERNAME")
        password = _require("SALONX_PASSWORD")
        print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] WordPress login to {BASE_URL} ...")
        wp_login(session, username, password)
        verify_authenticated(session)
    else:  # adfs (default)
        username = _require("SALONX_USERNAME")
        password = _require("SALONX_PASSWORD")
        print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] ADFS SSO login (Insite) to {BASE_URL} ...")
        sso_login(session, username, password)
        verify_authenticated(session)

    user_id = get_current_user_id(session)
    print(f"Authenticated. CurrentUserID={user_id}")

    min_date, max_date = compute_date_window()
    print(f"Downloading '{EXPORT_TYPE}'  (dates {min_date or 'ALL'}..{max_date or 'ALL'}, "
          f"status={STATUS or 'ALL'}, sort={SORT}) ...")
    content, filename, ctype = download_report(session, user_id)
    print(f"Got {len(content)} bytes  filename={filename}  type={ctype}")

    if os.environ.get("SALONX_SAVE_LOCAL"):
        with open(filename, "wb") as fh:
            fh.write(content)
        print(f"Saved local copy: {filename}")

    if os.environ.get("SALONX_SKIP_EMAIL") == "1":
        print("SALONX_SKIP_EMAIL=1 — skipping email step.")
        return 0

    send_email(content, filename, ctype)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

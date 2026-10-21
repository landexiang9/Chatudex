"""Read the optional, public site filing information without exposing app configuration."""

import json
from urllib.parse import urlsplit

from claude_chat.config import BASE_DIR

SITE_INFO_PATH = BASE_DIR / "site_info.json"


def load_site_info():
    """Missing, invalid or incomplete entries leave the original interface unchanged."""
    try:
        with SITE_INFO_PATH.open("rb") as source:
            content = source.read(65537)
        if len(content) > 65536:
            return {"filings": []}
        config = json.loads(content.decode("utf-8-sig"))
    except (OSError, ValueError, RecursionError):
        return {"filings": []}

    entries = config.get("filings") if isinstance(config, dict) else None
    filings = []
    if isinstance(entries, list):
        for entry in entries[:8]:
            if not isinstance(entry, dict):
                continue
            text, url = entry.get("text"), entry.get("url")
            if not isinstance(text, str) or not isinstance(url, str):
                continue
            text, url = text.strip(), url.strip()
            if not text or len(text) > 256 or not url or len(url) > 2048:
                continue
            if "\\" in url or any(ord(char) < 32 or ord(char) == 127 for char in url):
                continue
            try:
                parsed = urlsplit(url)
                if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
                    continue
                if parsed.username is not None or parsed.password is not None:
                    continue
                # Also reject malformed ports instead of passing them to the browser.
                parsed.port
            except ValueError:
                continue
            filings.append({"text": text, "url": url})
    return {"filings": filings}

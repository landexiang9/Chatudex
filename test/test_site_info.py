"""Optional public filing configuration, with no personal config or model calls."""

import json
import threading
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest

from claude_chat import site_info
from claude_chat.server import ClaudeChatHTTPHandler, ThreadingHTTPServer


@pytest.fixture
def info_path(tmp_path, monkeypatch):
    path = tmp_path / "site_info.json"
    monkeypatch.setattr(site_info, "SITE_INFO_PATH", path)
    return path


def test_missing_file_keeps_original_ui(info_path):
    assert site_info.load_site_info() == {"filings": []}


@pytest.mark.parametrize(
    "content",
    ["{", "[]", "null", '{"filings":{}}', '{"filings":[{"text":"","url":""}]}', "x" * 65537],
    ids=["malformed", "array", "null", "wrong-entries-type", "empty-entry", "oversized"],
)
def test_invalid_or_empty_configuration_is_optional(info_path, content):
    info_path.write_text(content, encoding="utf-8")
    assert site_info.load_site_info() == {"filings": []}


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "data:text/html,test",
        "//example.com",
        "/relative",
        "https://",
        "https://user:pass@example.com",
        "https://example.com:bad",
        "https://example.com/\npath",
        "https://example.com\\path",
    ],
)
def test_invalid_links_are_not_published(info_path, url):
    info_path.write_text(json.dumps({"filings": [{"text": "备案号", "url": url}]}), encoding="utf-8")
    assert site_info.load_site_info() == {"filings": []}


def test_only_complete_public_fields_are_exposed_and_file_is_reloaded(info_path):
    info_path.write_text(
        json.dumps(
            {
                "private": "never-publish",
                "filings": [
                    None,
                    {"text": "incomplete"},
                    {"text": " 备案号 ", "url": " https://example.com/filing ", "secret": "hidden"},
                ],
            }
        ),
        encoding="utf-8-sig",
    )
    assert site_info.load_site_info() == {"filings": [{"text": "备案号", "url": "https://example.com/filing"}]}
    info_path.write_text('{"filings": []}', encoding="utf-8")
    assert site_info.load_site_info() == {"filings": []}


def test_public_endpoint_does_not_change_api_authentication(info_path):
    info_path.write_text(
        json.dumps({"filings": [{"text": "备案号", "url": "https://example.com/filing"}], "secret": "hidden"}),
        encoding="utf-8",
    )
    app = SimpleNamespace(config={"security_token": "private-token"})
    server = ThreadingHTTPServer(("127.0.0.1", 0), ClaudeChatHTTPHandler, app, object())
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with urlopen(base + "/site-info.json", timeout=5) as response:
            assert response.status == 200
            assert response.headers["Cache-Control"] == "no-store"
            assert json.load(response) == {"filings": [{"text": "备案号", "url": "https://example.com/filing"}]}
        for path in ("/api/config", "/api/site-info.json"):
            with pytest.raises(HTTPError) as error:
                urlopen(base + path, timeout=5)
            assert error.value.code == 401
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)

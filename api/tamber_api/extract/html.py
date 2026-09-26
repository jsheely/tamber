"""HTML to readable paragraphs: trafilatura first, BeautifulSoup block text as the fallback."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

import trafilatura
from bs4 import BeautifulSoup, Tag
from bs4.element import NavigableString

from tamber_api.extract.normalize import clean_paragraph, strip_bullet

logger = logging.getLogger("tamber.extract")

BLOCK_TAGS = (
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
    "pre",
    "td",
    "th",
    "dt",
    "dd",
    "figcaption",
    "caption",
    "summary",
    "address",
)
_CONTAINER_TAGS = {"div", "section", "article", "main", "body", "header", "footer", "aside"}
_DROP_TAGS = (
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "iframe",
    "object",
    "embed",
    "form",
    "button",
    "select",
    "input",
    "textarea",
)
_BOILERPLATE_TAGS = ("nav", "header", "footer", "aside")
_HEADING_RE = re.compile(r"^h[1-6]$")


@dataclass(slots=True)
class HtmlDoc:
    title: str | None
    paragraphs: list[str]
    language: str | None
    first_heading: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


def _soup(markup: str | bytes) -> BeautifulSoup:
    return BeautifulSoup(markup, "lxml")


def html_language(soup: BeautifulSoup) -> str | None:
    html = soup.find("html")
    if isinstance(html, Tag):
        lang = html.get("lang") or html.get("xml:lang")
        if isinstance(lang, str) and lang.strip():
            return lang.strip()
    meta = soup.find("meta", attrs={"http-equiv": re.compile("^content-language$", re.I)})
    if isinstance(meta, Tag):
        content = meta.get("content")
        if isinstance(content, str) and content.strip():
            return content.split(",")[0].strip()
    return None


def html_title(soup: BeautifulSoup) -> str | None:
    for key, value in (("property", "og:title"), ("name", "twitter:title")):
        meta = soup.find("meta", attrs={key: value})
        if isinstance(meta, Tag):
            content = meta.get("content")
            if isinstance(content, str) and clean_paragraph(content):
                return clean_paragraph(content)
    if soup.title and soup.title.string:
        title = clean_paragraph(str(soup.title.string))
        if title:
            return title
    return None


def first_heading(soup: BeautifulSoup) -> str | None:
    for name in ("h1", "h2", "h3"):
        tag = soup.find(name)
        if isinstance(tag, Tag):
            text = clean_paragraph(tag.get_text(" "))
            if text:
                return text
    return None


_STRUCTURAL = (
    set(BLOCK_TAGS)
    | _CONTAINER_TAGS
    | {
        "ul",
        "ol",
        "dl",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "figure",
        "details",
        "nav",
        "hr",
    }
)


def block_paragraphs(root: BeautifulSoup | Tag, *, drop_code: bool = False) -> list[str]:
    """Text of block-level elements in document order.

    One linear walk: inline content accumulates into the current paragraph; every structural
    (block or container) element starts a new one, so nested blocks are never duplicated.
    """
    for tag in root.find_all(_DROP_TAGS):
        tag.decompose()
    if drop_code:
        for tag in root.find_all("pre"):
            tag.decompose()
    out: list[str] = []

    def walk(node: Tag) -> None:
        buf: list[str] = []

        def flush() -> None:
            if buf:
                text = "".join(buf)
                if clean_paragraph(text):
                    out.append(text)
                buf.clear()

        for child in node.children:
            if type(child) is NavigableString:
                buf.append(str(child))
            elif isinstance(child, Tag):
                if child.name in _STRUCTURAL:
                    flush()
                    walk(child)
                elif child.name == "br":
                    buf.append(" ")
                else:
                    buf.append(child.get_text(""))
        flush()

    if isinstance(root, Tag):
        walk(root)
    return out


def bs4_fallback(markup: str | bytes) -> HtmlDoc:
    soup = _soup(markup)
    language = html_language(soup)
    title = html_title(soup)
    heading = first_heading(soup)
    for tag in soup.find_all(_BOILERPLATE_TAGS):
        tag.decompose()
    body = soup.body or soup
    paragraphs = block_paragraphs(body)
    if not paragraphs:
        text = body.get_text("\n")
        paragraphs = [line for line in text.split("\n") if line.strip()]
    return HtmlDoc(title=title, paragraphs=paragraphs, language=language, first_heading=heading)


def extract_html(markup: str | bytes, url: str | None = None) -> HtmlDoc:
    """Main content of a page. Returns empty paragraphs when there is nothing readable."""
    soup = _soup(markup)
    language = html_language(soup)
    heading = first_heading(soup)
    fallback_title = html_title(soup)
    result: str | None = None
    try:
        result = trafilatura.extract(
            markup,
            url=url,
            output_format="json",
            with_metadata=True,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
        )
    except Exception:
        logger.warning("trafilatura failed; using the BeautifulSoup fallback", exc_info=True)
    if result:
        try:
            data = json.loads(result)
        except ValueError:
            data = {}
        text = str(data.get("text") or "")
        paragraphs = [strip_bullet(line) for line in text.split("\n") if line.strip()]
        if paragraphs:
            title = clean_paragraph(str(data.get("title") or "")) or fallback_title
            lang = language or (str(data["language"]) if data.get("language") else None)
            return HtmlDoc(
                title=title or None,
                paragraphs=paragraphs,
                language=lang,
                first_heading=heading,
                meta=data,
            )
    doc = bs4_fallback(markup)
    doc.language = doc.language or language
    doc.first_heading = doc.first_heading or heading
    return doc

"""Fetch a URL for extraction: manual redirects, SSRF checks per hop, byte cap and timeout."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from urllib.parse import unquote, urljoin, urlsplit

import httpx

from tamber_api import __version__
from tamber_api.errors import TamberError
from tamber_api.extract.ssrf import check_url

MAX_REDIRECTS = 5
USER_AGENT = f"Tamber/{__version__} (+self-hosted text-to-speech)"
ACCEPT = (
    "text/html,application/xhtml+xml,application/pdf,application/epub+zip,"
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document,"
    "text/markdown,text/plain;q=0.9,*/*;q=0.5"
)


@dataclass(slots=True)
class Fetched:
    url: str
    data: bytes
    content_type: str | None
    filename: str | None


def _filename_from_url(url: str) -> str | None:
    path = urlsplit(url).path
    name = unquote(path.rsplit("/", 1)[-1]) if path else ""
    return name or None


def _too_large(limit: int) -> TamberError:
    return TamberError(
        413,
        "file_too_large",
        f"The remote document is larger than {limit // (1024 * 1024)} MB.",
        param="url",
        details={"max": limit},
    )


async def fetch_url(
    url: str,
    *,
    timeout_s: float,
    max_bytes: int,
    allow_private: bool,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Fetched:
    """Download `url` following at most 5 redirects, re-checking every hop."""
    headers = {"User-Agent": USER_AGENT, "Accept": ACCEPT, "Accept-Language": "*"}
    timeout = httpx.Timeout(timeout_s)
    try:
        async with (
            asyncio.timeout(timeout_s),
            httpx.AsyncClient(
                follow_redirects=False,
                timeout=timeout,
                headers=headers,
                transport=transport,
                trust_env=False,
            ) as client,
        ):
            current = url
            for _hop in range(MAX_REDIRECTS + 1):
                await check_url(current, allow_private)
                async with client.stream("GET", current) as resp:
                    if resp.is_redirect:
                        location = resp.headers.get("location")
                        if not location:
                            raise TamberError(
                                502, "fetch_failed", "Redirect without a location.", param="url"
                            )
                        current = urljoin(str(resp.url), location)
                        continue
                    if resp.status_code >= 400:
                        raise TamberError(
                            502,
                            "fetch_failed",
                            f"The page answered HTTP {resp.status_code}.",
                            param="url",
                            details={"status": resp.status_code},
                        )
                    declared = resp.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > max_bytes:
                        raise _too_large(max_bytes)
                    buf = bytearray()
                    async for part in resp.aiter_bytes():
                        buf.extend(part)
                        if len(buf) > max_bytes:
                            raise _too_large(max_bytes)
                    return Fetched(
                        url=str(resp.url),
                        data=bytes(buf),
                        content_type=resp.headers.get("content-type"),
                        filename=_filename_from_url(str(resp.url)),
                    )
            raise TamberError(
                502, "fetch_failed", f"More than {MAX_REDIRECTS} redirects.", param="url"
            )
    except TamberError:
        raise
    except TimeoutError as exc:
        raise TamberError(
            502, "fetch_failed", f"Fetching the URL timed out after {timeout_s:g} s.", param="url"
        ) from exc
    except httpx.HTTPError as exc:
        raise TamberError(
            502, "fetch_failed", f"Could not fetch the URL ({type(exc).__name__}).", param="url"
        ) from exc

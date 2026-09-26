"""SSRF guard for URL extraction: only http(s) to public addresses (unless explicitly allowed).

Every redirect hop is checked. Known limitation: the check resolves the host, then httpx resolves
it again to connect, so a DNS-rebinding attacker with a very short TTL could race it. The guard
still blocks literal private IPs, internal hostnames and redirects into private ranges.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

from tamber_api.errors import TamberError

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


def _not_allowed(message: str) -> TamberError:
    return TamberError(400, "url_not_allowed", message, param="url")


def ip_is_blocked(ip: IPAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is not None:
            return ip_is_blocked(mapped)
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or not ip.is_global
    )


def parse_url(url: str) -> tuple[str, str, int]:
    """(scheme, host, port) of an http(s) URL; raises url_not_allowed otherwise."""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError as exc:
        raise _not_allowed("The URL is not valid.") from exc
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise _not_allowed("Only http:// and https:// URLs can be extracted.")
    host = parts.hostname
    if not host:
        raise _not_allowed("The URL has no host.")
    if parts.username or parts.password:
        raise _not_allowed("URLs with credentials are not allowed.")
    return scheme, host, port or (443 if scheme == "https" else 80)


async def check_url(url: str, allow_private: bool) -> None:
    """Validate scheme and (unless allowed) that every resolved address is public."""
    _, host, port = parse_url(url)
    if allow_private:
        return
    try:
        literal: IPAddress | None = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        literal = None
    if literal is not None:
        if ip_is_blocked(literal):
            raise _not_allowed("The URL points to a private or local address.")
        return
    lowered = host.lower().rstrip(".")
    if lowered == "localhost" or lowered.endswith((".localhost", ".local", ".internal")):
        raise _not_allowed("The URL points to a private or local address.")
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise TamberError(
            502, "fetch_failed", f"Could not resolve host '{host}'.", param="url"
        ) from exc
    if not infos:
        raise TamberError(502, "fetch_failed", f"Could not resolve host '{host}'.", param="url")
    for info in infos:
        address = str(info[4][0]).split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            raise _not_allowed("The URL resolves to an unrecognised address.") from None
        if ip_is_blocked(ip):
            raise _not_allowed("The URL resolves to a private or local address.")

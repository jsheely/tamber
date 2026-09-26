"""POST /v1/extract: readable text from a URL, client-supplied HTML, or an uploaded document."""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import PurePosixPath
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException

from tamber_api.errors import TamberError, invalid_request
from tamber_api.extract.files import HTML, Extracted, extract_document, extract_html_file
from tamber_api.extract.normalize import clean_paragraph, finalize
from tamber_api.extract.ssrf import parse_url
from tamber_api.extract.url import fetch_url
from tamber_api.routes.common import (
    AUTH_AND_LIMIT,
    read_json,
    request_id,
    settings_of,
    validate_body,
)

logger = logging.getLogger("tamber.extract")

router = APIRouter(dependencies=AUTH_AND_LIMIT, tags=["extract"])


class ExtractJson(BaseModel):
    model_config = ConfigDict(extra="ignore")

    url: str | None = None
    html: str | None = None


class ExtractResponse(BaseModel):
    title: str | None
    text: str
    source: str
    source_type: str
    mime_type: str | None
    word_count: int
    char_count: int
    truncated: bool
    language: str | None


def _stem(filename: str | None) -> str | None:
    if not filename:
        return None
    stem = PurePosixPath(filename.replace("\\", "/")).stem.strip()
    return stem or None


def _build_response(
    doc: Extracted,
    *,
    source: str,
    source_type: str,
    max_chars: int,
    filename: str | None,
) -> dict[str, Any]:
    normalized = finalize(doc.paragraphs, max_chars)
    if not normalized.text:
        raise TamberError(
            422,
            "extract_failed",
            "No readable text was found (it may be a scanned document or an empty page).",
        )
    title = clean_paragraph(doc.title) if doc.title else None
    if not title:
        title = _stem(filename)
    return ExtractResponse(
        title=title or None,
        text=normalized.text,
        source=source,
        source_type=source_type,
        mime_type=doc.mime_type,
        word_count=normalized.word_count,
        char_count=normalized.char_count,
        truncated=normalized.truncated,
        language=doc.language,
    ).model_dump()


async def _from_json(request: Request) -> dict[str, Any]:
    settings = settings_of(request)
    body = validate_body(ExtractJson, await read_json(request))
    url = body.url.strip() if body.url else None
    if body.html is not None:
        html_bytes = body.html.encode("utf-8", "surrogatepass")
        if len(html_bytes) > settings.max_upload_bytes:
            raise TamberError(
                413,
                "file_too_large",
                f"The html field is larger than {settings.max_upload_mb:g} MB.",
                param="html",
                details={"max": settings.max_upload_bytes, "actual": len(html_bytes)},
            )
        if url:
            parse_url(url)  # metadata only, but it must at least be an http(s) URL
        doc = await asyncio.to_thread(extract_html_file, html_bytes, url)
        return _build_response(
            doc,
            source=url or "",
            source_type="html",
            max_chars=settings.max_extract_chars,
            filename=None,
        )
    if url:
        fetched = await fetch_url(
            url,
            timeout_s=settings.extract_timeout_s,
            max_bytes=settings.extract_max_download_bytes,
            allow_private=settings.extract_allow_private,
            transport=getattr(request.app.state, "extract_transport", None),
        )
        doc = await asyncio.to_thread(
            extract_document, fetched.data, fetched.content_type, fetched.filename, fetched.url
        )
        return _build_response(
            doc,
            source=url,
            source_type="url",
            max_chars=settings.max_extract_chars,
            filename=fetched.filename if doc.mime_type != HTML else None,
        )
    raise invalid_request(
        [{"loc": ["body"], "msg": "Provide either 'url' or 'html'", "type": "missing"}],
        "Provide either 'url' or 'html'.",
    )


async def _from_form(request: Request) -> dict[str, Any]:
    settings = settings_of(request)
    try:
        form = await request.form(max_files=2, max_fields=20, max_part_size=1024 * 1024)
    except MultiPartException as exc:
        raise invalid_request(
            [{"loc": ["body"], "msg": str(exc), "type": "multipart_invalid"}],
            f"Invalid multipart body: {exc}",
        ) from exc
    try:
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise invalid_request(
                [{"loc": ["body", "file"], "msg": "Field required", "type": "missing"}],
                "Upload the document in a multipart field named 'file'.",
            )
        override = form.get("filename")
        filename = (
            override.strip() if isinstance(override, str) and override.strip() else upload.filename
        )
        data = await upload.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise TamberError(
                413,
                "file_too_large",
                f"The file is larger than {settings.max_upload_mb:g} MB.",
                param="file",
                details={"max": settings.max_upload_bytes},
            )
        content_type = upload.content_type
    finally:
        await form.close()
    doc = await asyncio.to_thread(extract_document, data, content_type, filename)
    return _build_response(
        doc,
        source=filename or "",
        source_type="file",
        max_chars=settings.max_extract_chars,
        filename=filename,
    )


@router.post(
    "/v1/extract",
    response_model=ExtractResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {"schema": ExtractJson.model_json_schema()},
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["file"],
                        "properties": {
                            "file": {"type": "string", "format": "binary"},
                            "filename": {"type": "string"},
                        },
                    }
                },
            },
        }
    },
)
async def extract(request: Request) -> dict[str, Any]:
    started = time.perf_counter()
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype == "multipart/form-data":
        result = await _from_form(request)
    else:
        result = await _from_json(request)
    logger.info(
        "request_id=%s extract source_type=%s mime=%s chars=%d words=%d truncated=%s elapsed_ms=%d",
        request_id(request),
        result["source_type"],
        result["mime_type"],
        result["char_count"],
        result["word_count"],
        result["truncated"],
        round((time.perf_counter() - started) * 1000),
    )
    return result

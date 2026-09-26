# syntax=docker/dockerfile:1.7
#
# Tamber: ONE image serving the API (FastAPI + Kokoro) and the built web UI.
# The build context is the REPO ROOT:
#
#   docker build -t tamber .
#   docker build --build-arg WEB_STAGE=web-empty -t tamber:api-only .   # no web UI
#   docker build --build-arg TORCH_VARIANT=cu130 -t tamber:cuda .          # NVIDIA GPU
#
# TORCH_VARIANT selects the PyTorch wheel channel. torch 2.14.0 is published for cpu, cu126, cu130
# and cu132 (not cu128). Channels rotate between PyTorch releases: check
# https://download.pytorch.org/whl/ for the current names when bumping TORCH_VERSION.
# TAMBER_LANGUAGES chooses which voices are baked in; keep it in sync with the runtime variable
# (the image sets it as the default).

ARG WEB_STAGE=web-build

# ---------------------------------------------------------------------------------------------
# web-build: packages/client + web  ->  /src/web/dist
# ---------------------------------------------------------------------------------------------
FROM node:24-slim AS web-build
WORKDIR /src
RUN npm install -g pnpm@10.28.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/client ./packages/client
COPY web ./web
# Every workspace member's manifest must exist for pnpm to validate the frozen lockfile.
COPY extension/package.json ./extension/package.json
COPY mobile/package.json ./mobile/package.json
COPY assets/brand ./assets/brand
# `@tamber/web...` = web plus its workspace dependencies (@tamber/client). The web build consumes
# the client's TypeScript source via its "source" export condition, so no separate client build.
RUN pnpm install --frozen-lockfile --filter @tamber/web... \
 && pnpm --filter @tamber/web build

# ---------------------------------------------------------------------------------------------
# web-empty: an empty dist for API-only images (--build-arg WEB_STAGE=web-empty)
# ---------------------------------------------------------------------------------------------
FROM python:3.12-slim AS web-empty
RUN mkdir -p /src/web/dist

FROM ${WEB_STAGE} AS web-dist

# ---------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

ARG TORCH_VARIANT=cpu
ARG TORCH_VERSION=2.14.0
ARG TAMBER_LANGUAGES=a,b
ARG TAMBER_MODEL_REPO=hexgrad/Kokoro-82M
ARG TAMBER_VERSION=0.1.0

LABEL org.opencontainers.image.title="Tamber" \
      org.opencontainers.image.description="Self-hosted Kokoro text-to-speech with word-level timestamps" \
      org.opencontainers.image.version="${TAMBER_VERSION}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/tamber/hf \
    HF_HUB_DISABLE_TELEMETRY=1

# System packages: none are required. Every dependency ships manylinux wheels, and misaki[en]
# pulls espeakng-loader, which bundles libespeak-ng + its data (no apt espeak-ng needed).
# Fallbacks if a platform ever lacks a wheel or the bundled espeak fails to load:
# RUN apt-get update && apt-get install -y --no-install-recommends build-essential espeak-ng \
#  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin tamber \
 && mkdir -p /opt/tamber/hf /app \
 && chown tamber:tamber /opt/tamber/hf

WORKDIR /app

# torch first, from the variant's own index (the PyPI wheel drags in GBs of CUDA libraries),
# then the base + TTS requirements with torch already satisfied, then the spaCy English model
# matching the resolved spaCy (misaki would otherwise download it at runtime).
COPY api/requirements.txt api/requirements-tts.txt ./
RUN pip install --extra-index-url "https://download.pytorch.org/whl/${TORCH_VARIANT}" \
        "torch==${TORCH_VERSION}+${TORCH_VARIANT}" \
 && grep -v -e '^torch==' -e '^--extra-index-url' requirements-tts.txt > /tmp/requirements-tts.txt \
 && pip install -r requirements.txt -r /tmp/requirements-tts.txt \
 && python -m spacy download en_core_web_sm \
 && rm -f /tmp/requirements-tts.txt requirements.txt requirements-tts.txt

# Bake the model + voices into the HF cache (verified, atomic, idempotent). Runs as the runtime
# user so the cache is owned by it.
COPY --chown=tamber:tamber api/scripts/download_models.py /app/scripts/download_models.py
USER tamber
RUN python /app/scripts/download_models.py \
        --repo "${TAMBER_MODEL_REPO}" --languages "${TAMBER_LANGUAGES}"

ENV HF_HUB_OFFLINE=1 \
    TAMBER_HOST=0.0.0.0 \
    TAMBER_PORT=8880 \
    TAMBER_LANGUAGES=${TAMBER_LANGUAGES} \
    TAMBER_MODEL_REPO=${TAMBER_MODEL_REPO} \
    TAMBER_WEB_DIR=/app/web

COPY --chown=tamber:tamber api/tamber_api /app/tamber_api
COPY --from=web-dist --chown=tamber:tamber /src/web/dist /app/web

EXPOSE 8880

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD ["python", "-c", "import json,os,sys,urllib.request as u; r=json.load(u.urlopen('http://127.0.0.1:%s/v1/health' % os.environ.get('TAMBER_PORT','8880'), timeout=4)); sys.exit(0 if r.get('status') == 'ok' else 1)"]

# One worker (one model in memory), proxy headers from TAMBER_FORWARDED_ALLOW_IPS, 75 s keep-alive.
CMD ["python", "-m", "tamber_api"]

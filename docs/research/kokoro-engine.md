# Kokoro TTS engine — research for Tamber's `api/` service

Researched 2026-09-26 against primary sources (PyPI JSON API, GitHub source at `hexgrad/kokoro` and `hexgrad/misaki` `main`, Hugging Face `hexgrad/Kokoro-82M`, `download.pytorch.org/whl/cpu`). All version numbers below were pulled live from the package registries on this date — do not assume they match training-data memory.

## TL;DR recommendations

- **Engine**: use the PyTorch `kokoro` package (hexgrad), not `kokoro-onnx`, as the primary engine — it is the *only* one that gives native word-level timestamps (`MToken.start_ts`/`end_ts`), and only for English (`lang_code` `a`/`b`). This is a hard fit with Tamber's NDJSON-chunk-with-word-timestamps design.
- **espeak-ng**: don't `apt-get install espeak-ng`. Kokoro's English pipeline pulls in `misaki[en]`, which depends on `espeakng-loader` — a PyPI package that ships a prebuilt `libespeak-ng` shared library + data for Linux glibc (x86_64/aarch64), Windows and macOS. `pip install misaki[en]` is sufficient in the Docker image; no system package needed for English. (Still worth installing `espeak-ng` at the OS level as a defensive fallback / for non-English `EspeakG2P` paths — see below.)
- **Torch**: the plain `pip install torch` wheel from PyPI now pulls a large chain of `nvidia-*`/`cuda-toolkit` dependencies on Linux even if you never touch a GPU. For the CPU-default image, install from `https://download.pytorch.org/whl/cpu` explicitly. This drops the wheel from ~550 MB (+ several GB of CUDA deps) to a self-contained ~196 MB.
- **kokoro-onnx**: correct project is **`thewh1teagle/kokoro-onnx`** (PyPI `kokoro-onnx`), not "thaddeus-e" (that name doesn't correspond to a maintainer of this project — the task brief's assumption is wrong). It's a good option for a smaller/quantized, GPU-optional footprint when you *don't* need word timestamps, or for edge/ARM deployments. It does not give word-level timestamps in the released model; its `create_timed()` API returns **phoneme**-level timing only, and only when the ONNX file was exported with a `duration` output (the standard released `kokoro-v1.0.onnx` doesn't guarantee this — you'd need a custom export). Given Tamber's hard requirement for word timestamps, treat kokoro-onnx as a possible *future* lightweight-mode option, not the v1 engine.
- **PDF**: default to `pypdf` (pure-Python, BSD-3-Clause) for license safety. Offer `pymupdf` as an optional fast path, but know it's **AGPL-3.0** (commercial license available from Artifex) — that's a real constraint if Tamber is ever distributed/hosted-for-others under a permissive license.
- **URL article extraction**: `trafilatura` is the best default (highest F1 in independent benchmarks), with `readability-lxml` already pulled in as one of its internal fallbacks.

---

## 1. The `kokoro` package (hexgrad)

### 1.1 Package facts (verified via PyPI JSON API, 2026-09-26)

| Package | Version | `requires_python` |
|---|---|---|
| `kokoro` | **0.9.4** | `<3.13,>=3.10` |
| `misaki` | **0.9.4** | `<3.13,>=3.8` |

`kokoro`'s declared runtime deps (unpinned, from PyPI metadata):

```
huggingface-hub
loguru
misaki[en]>=0.9.4
numpy
torch
transformers
```

Note the `<3.13` upper bound — **kokoro 0.9.4 does not officially support Python 3.13+**, but is fine on the project's Python 3.12.10. Watch for a future kokoro release relaxing this if the toolchain ever moves to 3.13.

Sources: [kokoro · PyPI](https://pypi.org/project/kokoro/), [PyPI JSON API](https://pypi.org/pypi/kokoro/json), [misaki · PyPI](https://pypi.org/project/misaki/).

### 1.2 Install

```bash
pip install kokoro>=0.9.4 misaki[en] soundfile
```

`misaki[en]` extra pulls in: `espeakng-loader`, `num2words`, `phonemizer-fork`, `spacy`, `spacy-curated-transformers` (the last two are used for the transformer-based G2P path when `KPipeline(trf=True)`; default `trf=False` still imports spacy for its rule-based/POS-tag English G2P).

### 1.3 `KPipeline` — real constructor signature (from `kokoro/pipeline.py` on `main`)

```python
class KPipeline:
    def __init__(
        self,
        lang_code: str,
        repo_id: Optional[str] = None,       # default 'hexgrad/Kokoro-82M' (warns if omitted)
        model: Union[KModel, bool] = True,   # True=build own KModel, False="quiet" (G2P only, no audio), or pass a shared KModel
        trf: bool = False,                   # transformer-based G2P (English only)
        en_callable: Optional[Callable[[str], str]] = None,
        device: Optional[str] = None,        # 'cuda' | 'mps' | 'cpu' | None (auto-detect)
    ):
```

**Always pass `repo_id='hexgrad/Kokoro-82M'` explicitly** — the constructor prints a `WARNING:` to stdout every time it's omitted (annoying in container logs; a plain `print`, not `logger.warning`).

`model=False` gives a "quiet" pipeline that only does grapheme→phoneme (and, for English, tokenization/timestSamp-shape) without running the neural model — useful if you want to pre-tokenize/chunk text server-side before committing to inference (e.g., to compute a stable chunk plan before spawning the actual TTS work).

Share **one `KModel`** across multiple `KPipeline`s (one per language) rather than letting each pipeline build its own — `KModel` is "language-blind" and stateless w.r.t. language, per its own docstring.

### 1.4 Language codes

```python
LANG_CODES = {
    'a': 'American English',   # pip install misaki[en]   — WORD TIMESTAMPS
    'b': 'British English',    # pip install misaki[en]   — WORD TIMESTAMPS
    'e': 'es',                 # espeak-ng fallback, no timestamps
    'f': 'fr-fr',               # espeak-ng fallback, no timestamps
    'h': 'hi',                  # espeak-ng fallback, no timestamps
    'i': 'it',                  # espeak-ng fallback, no timestamps
    'p': 'pt-br',                # espeak-ng fallback, no timestamps
    'j': 'Japanese',            # pip install misaki[ja]  — no timestamps
    'z': 'Mandarin Chinese',    # pip install misaki[zh]  — no timestamps
}
# aliases you can pass instead of the single-letter code:
ALIASES = {'en-us':'a','en-gb':'b','es':'e','fr-fr':'f','hi':'h','it':'i','pt-br':'p','ja':'j','zh':'z'}
```

For `e/f/h/i/p` (plain espeak-ng languages) the code takes an entirely different, much simpler branch (`self.g2p = espeak.EspeakG2P(language=...)`) which logs a warning that **"Chunking logic not yet implemented"** for these languages — long texts can silently truncate unless you pre-split on `\n`. Design implication for Tamber: if/when non-English voices are exposed in the UI, the API layer must do its own sentence chunking for these languages rather than relying on `KPipeline`'s internal `en_tokenize`, which only runs for `a`/`b`.

### 1.5 Word-level timestamps — exactly how they work (English only)

This is the mechanism Tamber's NDJSON/word-highlight design depends on, so it's worth documenting precisely, not just "it works."

**`misaki.token.MToken`** (from `misaki/token.py`, the actual dataclass):

```python
@dataclass
class MToken:
    text: str
    tag: str
    whitespace: str
    phonemes: Optional[str] = None
    start_ts: Optional[float] = None   # seconds, filled in only for lang_code in ('a','b')
    end_ts: Optional[float] = None     # seconds
    _: Optional[Underscore] = None     # extra features: is_head, alias, stress, currency, num_flags, prespace, rating
```

`start_ts`/`end_ts` are **only ever populated for `lang_code in ('a', 'b')`** (American/British English). For Japanese, Mandarin, and the espeak-ng languages, `KPipeline.Result.tokens` is `None` — there is no per-token timestamp path in those branches of `__call__` at all (confirmed by reading `kokoro/pipeline.py`: only the `if self.lang_code in 'ab':` branch calls `en_tokenize` + `join_timestamps` and sets `tokens=tks` on the `Result`; the `else` branch's `yield` doesn't pass `tokens` at all, leaving the dataclass default of `None`).

**Where the numbers come from.** The model (`kokoro/model.py`, `KModel.forward_with_tokens`) predicts a per-phoneme duration (`pred_dur`, an integer count of "frames") via its `ProsodyPredictor`. `KPipeline.join_timestamps` (static method) walks the token list and the `pred_dur` tensor together and assigns `t.start_ts`/`t.end_ts` in seconds:

```python
@staticmethod
def join_timestamps(tokens: List[en.MToken], pred_dur: torch.LongTensor):
    # Multiply by 600 to go from pred_dur frames to sample_rate 24000
    # (equivalently, divide by 40 to get seconds; here counted in half-frames, divisor 80)
    MAGIC_DIVISOR = 80
    ...
    for t in tokens:
        ...
        t.start_ts = left / MAGIC_DIVISOR
        token_dur = pred_dur[i:j].sum().item()
        ...
        t.end_ts = left / MAGIC_DIVISOR
```

This runs automatically inside both `KPipeline.__call__` and `KPipeline.generate_from_tokens` whenever `output.pred_dur is not None` — you don't call it yourself; you just read `result.tokens[i].start_ts/.end_ts` after iterating the pipeline generator.

**Usage pattern for the API:**

```python
from kokoro import KPipeline

pipeline = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')

for result in pipeline(text, voice='af_heart', speed=1.0):
    audio = result.audio          # torch.FloatTensor, mono, 24 kHz
    for tok in (result.tokens or []):
        if tok.start_ts is None or not tok.phonemes:
            continue  # punctuation-only / untimed tokens — skip
        word = tok.text            # original grapheme text of the word
        ws = tok.whitespace         # trailing whitespace, useful for offset math back into source text
        start_s, end_s = tok.start_ts, tok.end_ts
```

Practical gotchas worth carrying into the API design doc:
- Punctuation-only and untimed tokens can appear with `phonemes` empty/`None` — filter them out before building the word-highlight track (this matches what the original Kokoro-FastAPI's caption code and one blog's from-scratch reimplementation both do — filter empty/punctuation tokens, and treat missing timestamps as "fail this chunk" rather than silently emitting wrong offsets).
- `result.tokens` is chunked *within* a single `pipeline()` call by `en_tokenize` (it waterfalls at sentence/clause boundaries to keep each phoneme string ≤510 chars for the model's context window) — a single input string you pass to `pipeline()` can yield multiple `Result`s, each with its own token list and independently-zeroed timestamps (`t.start_ts` is relative to the start of *that* chunk's audio, not the whole utterance). If Tamber does its own upstream sentence chunking (as its architecture doc specifies, to produce one NDJSON line per chunk), it's cleanest to call `KPipeline.generate_from_tokens` (or just feed one sentence per `pipeline()` call) per own-chunk so that each chunk's `Result.audio` and `Result.tokens[*].start_ts` line up 1:1 with the character offsets you're already tracking into the source text.
- `Result` also exposes `.graphemes`, `.phonemes`, `.text_index` (index of the input segment when you pass a list or a `split_pattern`-split string) — `text_index` is handy for mapping a chunk back to which piece of your original chunk plan it belongs to.

Sources: [`kokoro/kokoro/pipeline.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py), [`kokoro/kokoro/model.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/model.py), [`misaki/misaki/token.py`](https://github.com/hexgrad/misaki/blob/main/misaki/token.py), [Kokoro for TTS and word timestamps — Ryan Welch](https://ryanwelch.co.uk/blog/kokoro-word-timestamps/) (independent write-up confirming the same `MToken.start_ts/end_ts` / `join_timestamps` mechanism and the "fail closed on missing timestamps" pattern).

### 1.6 Voices — loading, catalog, sample rate, speed

**Loading mechanism** (`KPipeline.load_single_voice`, real source):

```python
def load_single_voice(self, voice: str):
    if voice in self.voices:
        return self.voices[voice]
    if voice.endswith('.pt'):
        f = voice
    else:
        f = hf_hub_download(repo_id=self.repo_id, filename=f'voices/{voice}.pt')
        ...
    pack = torch.load(f, weights_only=True)
    self.voices[voice] = pack
    return pack
```

So each voice is a separate `.pt` file at `voices/<name>.pt` inside the `hexgrad/Kokoro-82M` HF repo, lazily downloaded via `huggingface_hub.hf_hub_download` (which caches to the standard HF cache dir — `~/.cache/huggingface/hub` — so mount/persist that volume in the Docker container to avoid re-downloading voices on every restart) and loaded with `torch.load(..., weights_only=True)`. A voice tensor's shape is `[510, 1, 256]` — 510 rows, one per possible phoneme-string length (1–510), each a 256-dim style vector; `KModel.forward` indexes it as `pack[len(ps)-1]`.

**Sample rate**: **24,000 Hz**, mono, float32 waveform (confirmed both in the README's `sf.write(f'{i}.wav', audio, 24000)` example and implicitly by the model's own docstring/training — there's no explicit `SAMPLE_RATE` constant in `kokoro/model.py`; it's a property of the trained decoder, and every downstream tool, including `kokoro-onnx`'s own `SAMPLE_RATE` constant, agrees on 24000).

**Speed**: the `speed` parameter to both `KPipeline.__call__` and `KPipeline.generate_from_tokens` accepts either a `float` multiplier (applied as `duration = sigmoid(duration).sum(...) / speed` inside `KModel.forward_with_tokens` — i.e., **higher `speed` value = shorter predicted phoneme durations = faster speech**) or a `Callable[[int], float]` (called with the phoneme-string length, letting you vary speed by chunk size).

**Voice catalog** (from `VOICES.md` in `hexgrad/Kokoro-82M` on Hugging Face, main branch):

| Language | Voices | Notes |
|---|---|---|
| American English | 20 (11F, 9M) | `af_heart`, `af_alloy`, `af_aoede`, `af_bella`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky` (F); `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`, `am_santa` (M) |
| British English | 8 (4F, 4M) | `bf_alice`, `bf_emma`, `bf_isabella`, `bf_lily`; `bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis` |
| Japanese | 5 (4F, 1M) | `jf_alpha`, `jf_gongitsune`, `jf_nezumi`, `jf_tebukuro`; `jm_kumo` |
| Mandarin Chinese | 8 (4F, 4M) | `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi`; `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang` |
| Spanish | 3 (1F, 2M) | `ef_dora`; `em_alex`, `em_santa` |
| French | 1 (1F) | `ff_siwis` |
| Hindi | 4 (2F, 2M) | `hf_alpha`, `hf_beta`; `hm_omega`, `hm_psi` |
| Italian | 2 (1F, 1M) | `if_sara`; `im_nicola` |
| Brazilian Portuguese | 3 (1F, 2M) | `pf_dora`; `pm_alex`, `pm_santa` |

Voice-name convention: first letter = language code (matches `LANG_CODES` keys), second letter = gender (`f`/`m`), rest = the voice's name. `VOICES.md` also assigns each voice a letter quality **grade** (A–F, reflecting quantity/quality of training data for that voice) — worth surfacing in the UI as a rough "recommended" hint for non-English voices, most of which grade C or lower.

Non-English support quality caveat straight from the source: *"Support for non-English languages may be absent or thin due to weak G2P and/or lack of training data, and some languages are only represented by a small handful or even just one voice (French)."* — set UI expectations accordingly.

**Voice blending** — this is a first-class, built-in feature of `KPipeline.load_voice`, not something you have to hand-roll:

```python
def load_voice(self, voice: Union[str, torch.FloatTensor], delimiter: str = ",") -> torch.FloatTensor:
    ...
    packs = [self.load_single_voice(v) for v in voice.split(delimiter)]
    if len(packs) == 1:
        return packs[0]
    self.voices[voice] = torch.mean(torch.stack(packs), dim=0)
    return self.voices[voice]
```

So `pipeline(text, voice='af_bella,af_sarah')` blends two (or more) voices with an unweighted mean — this is exactly how the community's popular `af` ("Bella+Sarah 50/50") voice is defined, and it's reproducible with plain `torch.mean(torch.stack([bella, sarah]), dim=0)`. There's **no built-in weighted blend** — for a weighted mix (e.g. 60/40) you load the individual `.pt` packs yourself and do `w1*bella + w2*sarah` (weights summing to 1) before passing the resulting tensor directly as `voice=<FloatTensor>` (both `load_voice`/`__call__` accept a raw `torch.FloatTensor` in place of a name string). If Tamber wants a "voice mixer" feature, this is the exact API surface to build it on.

Sources: [`VOICES.md` · hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md), [`kokoro/kokoro/pipeline.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py), [Kokoro-82M — Simeon Emanuilov / UnfoldAI write-up on voice mixing](https://unfoldai.com/kokoro-82m/).

---

## 2. misaki G2P and espeak-ng

`misaki` (also by hexgrad) is Kokoro's grapheme-to-phoneme layer. **Current version: 0.9.4** (kept in lockstep with `kokoro`'s own version). It's structured entirely around pip extras, one per language family:

```
misaki[en]  -> espeakng-loader, num2words, phonemizer-fork, spacy, spacy-curated-transformers
misaki[ja]  -> fugashi, jaconv, mojimoji, pyopenjtalk, unidic
misaki[zh]  -> cn2an, jieba, ordered-set, pypinyin, pypinyin-dict
misaki[ko]  -> jamo, nltk
misaki[vi]  -> num2words, spacy, spacy-curated-transformers, underthesea
misaki[he]  -> mishkal-hebrew>=0.3.2
```
Base package deps (always installed): `addict`, `regex`.

**Does it need system `espeak-ng`?** For the English path (which is all Tamber needs for timestamps, and the only G2P Tamber's UI needs to fully support): **no**. `misaki/espeak.py` does:

```python
from phonemizer.backend.espeak.wrapper import EspeakWrapper
import espeakng_loader
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
```

`espeakng_loader` (PyPI, current version **0.2.4**) bundles prebuilt `libespeak-ng` shared libraries + `espeak-ng-data` for **Linux glibc 2.17+ (x86_64) / glibc 2.28+ (aarch64), Windows (x86_64/ARM64), and macOS (x86_64/ARM64)**. `pip install misaki[en]` (which pulls `espeakng-loader` transitively) is self-contained — no `apt-get install espeak-ng` required for English in a `python:3.12-slim` (Debian) container.

`EspeakG2P`/`EspeakFallback` are still used in two places even on the English path: (1) `EspeakFallback` (real espeak-ng invocation) is used only as a *last resort* when misaki's own rule-based/dictionary English G2P can't phonemize a word (out-of-dictionary word) — this uses the same bundled library, not the system one; (2) the plain espeak-ng languages (`e/f/h/i/p`) go through `EspeakG2P` exclusively, same mechanism.

**If you still want the system package** (e.g., as a defensive fallback, or because you're troubleshooting a platform where the bundled `.so` doesn't load — `espeakng_loader` covers most but you may hit an edge case on unusual base images), the Debian/Ubuntu apt package name is simply:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
 && rm -rf /var/lib/apt/lists/*
```

`phonemizer`'s own docs/wrapper still support `ESPEAK_LIBRARY`/pointing at a system install, but with `espeakng_loader` in the dependency chain there's no need to do that plumbing yourself — it happens at import time in `misaki.espeak`.

Sources: [`misaki/misaki/espeak.py`](https://github.com/hexgrad/misaki/blob/main/misaki/espeak.py), [espeakng-loader · PyPI](https://pypi.org/project/espeakng-loader/), [misaki · PyPI](https://pypi.org/project/misaki/) (extras via `requires_dist`).

---

## 3. torch: CPU vs CUDA wheels, and Docker image size

This is the single biggest image-size lever in the whole stack.

**As of today, `pip install torch` (no index override) gets you version 2.14.0**, and on Linux its metadata **unconditionally** (not just as an optional extra) depends on:

```
cuda-toolkit[cublas,cudart,cufft,cufile,cupti,curand,cusolver,cusparse,nvjitlink,nvrtc,nvtx]==13.0.3 ; platform_system == "Linux"
cuda-bindings<14,>=13.0.3       ; platform_system == "Linux" and python_version < "3.15"
nvidia-cudnn-cu13==9.24.0.43    ; platform_system == "Linux"
nvidia-cusparselt-cu13==0.8.1   ; platform_system == "Linux"
nvidia-nccl-cu13==2.30.7        ; platform_system == "Linux"
nvidia-nvshmem-cu13==3.4.5      ; platform_system == "Linux"
triton~=3.8.0                   ; platform_system == "Linux" and python_version < "3.15"
```

The `torch` wheel itself is **554.6 MB** (`torch-2.14.0-cp312-cp312-manylinux_2_28_x86_64.whl`) — and that's *before* the multi-gigabyte pile of `nvidia-*`/`cuda-toolkit` packages above install alongside it, purely because they're plain (non-extra-gated) Linux dependencies of the default wheel now. This is true **even if you have no GPU and no intention of using one** — a naive `pip install torch` in a CPU-only container silently downloads GBs of CUDA userspace libraries that will never be touched.

**Fix: use PyTorch's own CPU wheel index**, which is a separate, self-contained build with no `nvidia-*` deps:

```dockerfile
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch
```

Verified directly against that index today: the CPU wheel is `torch-2.14.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl`, **196.3 MB**, no `nvidia-*`/`cuda-toolkit` dependency chain at all. That's the number to design the Docker image budget around for the CPU-default deployment.

**For an optional CUDA build**, the cleanest approach is a Dockerfile `ARG` that switches the pip index:

```dockerfile
ARG TORCH_VARIANT=cpu   # cpu | cu126 | cu128 (check https://download.pytorch.org/whl/ for the current CUDA channel names)
RUN pip install --index-url https://download.pytorch.org/whl/${TORCH_VARIANT} torch
```

and a corresponding `--build-arg TORCH_VARIANT=cu128` for a GPU image variant. (Confirm the exact current CUDA channel name against `https://download.pytorch.org/whl/` at build time — PyTorch periodically retires older CUDA channels; don't hardcode `cu121`/`cu124` etc. from memory.)

`kokoro`'s own `requires_dist` just says `torch` (unpinned) — it does not force the CUDA-bundling default wheel, so installing the CPU wheel first (or via `--index-url`) and then `pip install kokoro --no-deps` + the rest of its deps individually, or simply listing `torch` before `kokoro` in a requirements file with the CPU index set as the *primary* index for the whole build, both work. The simplest robust pattern in a `Dockerfile`/`requirements.txt` combo is:

```
--extra-index-url https://download.pytorch.org/whl/cpu
torch==2.14.0+cpu
kokoro==0.9.4
misaki[en]==0.9.4
```

(pip prefers an exact local-version match like `2.14.0+cpu` when it's present in an index that's searched, so pinning the `+cpu` local version explicitly avoids any risk of pip reaching for the default CUDA-bundling wheel from PyPI instead.)

Sources: [torch · PyPI JSON API](https://pypi.org/pypi/torch/json), [download.pytorch.org/whl/cpu index](https://download.pytorch.org/whl/cpu/torch/), [Using uv with PyTorch — Astral Docs](https://docs.astral.sh/uv/guides/integration/pytorch/) (independently confirms "only the wheels of the latest CUDA release are uploaded to PyPI... for CPU-only, use the dedicated index").

---

## 4. kokoro-onnx alternative

**Correct identity**: GitHub [`thewh1teagle/kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx), PyPI package name **`kokoro-onnx`**, current version **0.6.1** (`requires_python: <3.14,>=3.10` — fine for 3.12). The task brief's "thaddeus-e" attribution does not match any maintainer of this project as far as the source and PyPI metadata show; treat that name as mistaken and use `thewh1teagle` as the reference.

**Dependencies** (from PyPI metadata):
```
espeakng-loader>=0.2.4
numpy>=2.0.2
onnxruntime>=1.20.1
phonemizer>=3.4.0
onnxruntime-gpu>=1.20.1 ; extra == "gpu" (x86_64, non-macOS)
```
`onnxruntime` CPU wheel is small — **23.6 MB** (`onnxruntime-1.30.0-cp312-cp312-manylinux_2_28_x86_64.whl`) — vs `onnxruntime-gpu` at **246.7 MB**. No PyTorch dependency at all, which is the real appeal: a `kokoro-onnx`-based image can be dramatically smaller than a `torch`-based one.

**Model files**: `kokoro-v1.0.onnx` + `voices-v1.0.bin`, downloaded separately from GitHub releases (not from pip) — full precision ~300 MB total, or a quantized variant at ~80 MB.

**Timestamps — the key limitation for Tamber.** `kokoro-onnx` does have a `create_timed()`/`create_stream()` API that returns `Timing` objects, but:
- `self.has_timings = "duration" in {o.name for o in session.get_outputs()}` — timing support is **gated on the loaded ONNX model exposing a `duration` output tensor**. The standard released `kokoro-v1.0.onnx` is not documented as guaranteeing this; getting it requires exporting your own ONNX graph via the project's `scripts/export.py`.
- Even when available, the timing granularity is **per-phoneme** (`timings(self.tokenizer.known(phonemes), edges, SAMPLE_RATE)`), not per-word — you'd have to re-group phoneme spans into words yourself, essentially reimplementing what `hexgrad/kokoro`'s `MToken`/`join_timestamps` already does for you at the word level.
- Continuous/streaming synthesis (`create_stream`, `_create_continuous`) explicitly raises if the model lacks duration outputs: `"continuous synthesis needs a model that reports durations, export one with scripts/export.py"`.

**When kokoro-onnx is the better call**: a lightweight/edge deployment (e.g. Raspberry Pi, per one Mike Esto blog write-up on running Kokoro-82M on a Pi via ONNX) where PyTorch's footprint is unacceptable, a scenario where word-level highlighting isn't needed, or a future "fast/low-fidelity" mode. **For Tamber v1, given the hard requirement for word timestamps to drive karaoke-style highlighting, stick with the PyTorch `kokoro` package.** Keep `kokoro-onnx` noted as a documented future option (e.g., a `TAMBER_ENGINE=onnx` mode without highlighting) rather than architecting around it now.

Sources: [kokoro-onnx · PyPI](https://pypi.org/project/kokoro-onnx/), [PyPI JSON API](https://pypi.org/pypi/kokoro-onnx/json), [`thewh1teagle/kokoro-onnx` README](https://github.com/thewh1teagle/kokoro-onnx), [`kokoro_onnx/__init__.py` source](https://github.com/thewh1teagle/kokoro-onnx/blob/main/src/kokoro_onnx/__init__.py), [Kokoro-82M high quality TTS on a Raspberry Pi — Mike Esto](https://mikeesto.com/posts/kokoro-82m-pi/).

---

## 5. CPU latency — what people actually report

Numbers are all over the map because CPU inference for this model is very hardware-sensitive; treat these as *ballpark*, and benchmark Tamber's actual target hardware before promising latency in the UI.

- **Real-time factor (RTF)** — wall-clock synthesis time ÷ audio duration produced; RTF < 1.0 is faster than real time. Community reports for Kokoro on CPU cluster around **RTF ≈ 0.45–0.51** on decent modern CPUs across a range of text lengths, but some setups report **RTF 1.4×–4.5×** (i.e. *slower* than real time) on weaker hardware.
- **First-audio latency** (relevant to Tamber's chunked-streaming design, since first-chunk latency is what the user perceives as "responsiveness"): reports range from **sub-1-second on Apple Silicon (M3 Pro)** to **~3.5 s on an older desktop i7**, and a short (59-char) sentence taking **~1.8 s** end-to-end on one CPU benchmark.
- **GPU comparison for context**: RTF ≈ **0.03 on an A100** (a 10 s clip in ~0.3 s), first audio ≈ 300 ms, using roughly **2–3 GB VRAM**; the original Kokoro-FastAPI project's own README claims "~35×–100×+ real time on a 4060 Ti+" and "~5×+ real time on an M3 Pro CPU" (note: that specific "5x on CPU" figure is Kokoro-FastAPI's own marketing claim and is on the optimistic end vs. the independent CPU benchmarks above — take the RTF ≈ 0.45–0.51 community numbers as the more conservative planning baseline for a generic x86 CPU deployment).
- **Model footprint**: weights fit comfortably under 1 GB; total working memory during CPU inference is modest (low single-digit GB including the surrounding Python/torch/transformers process, not model-specific VRAM figures which don't apply to CPU).

Design implication: Tamber's per-sentence-chunk NDJSON streaming approach is a good fit *specifically because* CPU latency is inconsistent — starting playback from the first small chunk while later chunks are still generating hides a lot of this variance from the user, versus waiting for the whole utterance.

Sources: [Kokoro-FastAPI wiki: Streaming & Performance Optimization — DeepWiki](https://deepwiki.com/remsky/Kokoro-FastAPI/7.2-streaming-and-performance-optimization), [remsky/Kokoro-FastAPI README](https://github.com/remsky/Kokoro-FastAPI), [Kokoro 82M vs Supertonic 3: A Real CPU TTS Benchmark](https://heyneo.com/blog/kokoro-tts-vs-supertonic-3-tts), [Self-Hosted TTS with Kokoro ONNX — NemesisNet Lab](https://blog.nemesisnet.co.za/self-hosted-tts-with-kokoro-onnx-what-cpu-only-inference-actually-gets-you/).

---

## 6. Text extraction from URLs (for the API's "read this page" feature)

Independent benchmark numbers (content-extraction accuracy, F1 against a labeled dataset — see contextractor's writeup, itself citing the same kind of evaluation trafilatura publishes in its own docs):

| Library | F1 (independent benchmark) | Design |
|---|---|---|
| **trafilatura** 2.2.0 | **0.958** (highest) | General-purpose extraction pipeline with its *own* fallback chain: tries its own heuristics, then falls back to `jusText`/`readability-lxml` internally |
| newspaper4k 0.9.6 | 0.949 | News-focused; built-in light NLP (keyword/summary extraction) on top |
| readability-lxml 0.9 | 0.922 | Minimal, a Python port of Firefox Reader View / arc90's original readability algorithm — lowest overhead, also used internally by trafilatura as a fallback |

**Recommendation: `trafilatura` as the primary/only extractor.** It already subsumes `readability-lxml` as an internal fallback path (trafilatura's own `requires_dist` doesn't show `readability-lxml`/`justext` as a hard dependency in the same way — it vendors/depends on `justext` directly per its PyPI metadata: `certifi, charset_normalizer, courlan, htmldate, justext, lxml, urllib3`), so there's little benefit to also wiring in `readability-lxml` or `newspaper4k` separately unless a specific site proves troublesome. `newspaper4k` pulls a heavier dependency tree (`beautifulsoup4`, `feedparser`, `pillow`, `tldextract`, `w3lib`, ...) for a marginal accuracy trade **against** trafilatura on generic articles, plus it's oriented at *news* sites specifically (feed parsing, image/thumbnail extraction) — not needed for Tamber's "read me this page" use case.

**API usage** (trafilatura, current 2.x API):

```python
from trafilatura import fetch_url, extract

downloaded = fetch_url(url)
result = extract(downloaded, output_format="json", with_metadata=True)
# result is a JSON string; parse it — includes "title", "text", "author", "date", etc.
import json
data = json.loads(result)
title, body_text = data["title"], data["text"]
```

(`with_metadata=True` + `output_format="json"` is the most reliable way to get `title` back alongside the extracted `text` in one call, rather than making a second `extract_metadata()` call.)

Sources: [Trafilatura vs. Readability vs. Newspaper4k — contextractor](https://www.contextractor.com/trafilatura-vs-readability-vs-newspaper/), [Benchmarks and evaluation — Trafilatura docs](https://trafilatura.readthedocs.io/en/latest/evaluation.html), [trafilatura · PyPI](https://pypi.org/project/trafilatura/) (`requires_dist`), [trafilatura quickstart docs](https://trafilatura.readthedocs.io/en/latest/quickstart.html).

---

## 7. Extracting uploaded files (PDF / DOCX / EPUB / TXT / HTML)

### PDF: `pypdf` vs `pymupdf` — **the license difference matters here**

| | `pypdf` 6.19.0 | `pymupdf` 1.28.2 |
|---|---|---|
| License | **BSD-3-Clause** | **AGPL-3.0** (or a paid commercial license from Artifex) |
| Implementation | Pure Python | C (MuPDF) via bindings |
| Speed | Baseline | Independently benchmarked **~10–50× faster** than pure-Python extraction (one 2026 benchmark: 0.19 s/PDF vs 1.99 s/PDF for pypdf) |
| Extras | `pypdf[crypto]`/`[cryptodome]` for encrypted PDFs, `[full]` for images/fonts/bidi text | Built-in OCR/table/layout features |
| Import name | `pypdf` | `import pymupdf` (the historical `import fitz` alias still works and is still supported, per Artifex, but `pymupdf` is the forward-looking name) |

**Recommendation**: default to **`pypdf`** for the shipped Dockerfile/dependency set, specifically *because* of the AGPL question — Tamber's own license/distribution model isn't nailed down in this research task, and pulling an AGPL dependency into a self-hosted product that might later be shared/distributed is a decision that shouldn't be made implicitly by a dependency pin. If PDF extraction quality/speed becomes a real problem in practice (garbled text from complex layouts, which pure-Python extractors are more prone to), revisit with `pymupdf` as an explicit, documented opt-in — flagged clearly wherever it's wired in, so whoever owns licensing can make the call consciously.

```python
from pypdf import PdfReader
reader = PdfReader(file_obj)
text = "\n".join(page.extract_text() or "" for page in reader.pages)
title = (reader.metadata and reader.metadata.title) or None  # PDF metadata title, often missing/wrong — fall back to filename or first heading heuristically
```

### DOCX: `python-docx`

Current version **1.2.0**, MIT-style license, depends only on `lxml>=3.1.0` + `typing_extensions>=4.9.0`. It's the standard, well-maintained choice — reads/writes `.docx` structure (paragraphs, headings, tables, core properties).

```python
import docx
doc = docx.Document(file_obj)
text = "\n".join(p.text for p in doc.paragraphs)
title = doc.core_properties.title or (doc.paragraphs[0].text if doc.paragraphs else None)
```

(`core_properties.title` is the file's metadata title field, which is frequently blank for casually-authored documents — falling back to the first paragraph/heading text is the pragmatic default, same pattern as the PDF case above.)

A lighter alternative, `docx2txt`, exists purely for flat text dumps (also grabs header/footer/hyperlink text in one string) if `python-docx`'s structured API is more than needed — but `python-docx` is the better default since Tamber also wants a document **title**, which needs at least a little structure-awareness.

### EPUB: `ebooklib`

Current version **0.20** (BSD-style, depends on `lxml`, `six` — note `six` is a very old compatibility shim; the package itself hasn't had major version churn, which is normal for a mature, narrow-purpose library). Basic pattern:

```python
import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup

book = epub.read_epub(path)
title = book.get_metadata("DC", "title")[0][0] if book.get_metadata("DC", "title") else None
chapters_text = []
for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
    soup = BeautifulSoup(item.get_content(), "html.parser")
    chapters_text.append(soup.get_text())
text = "\n\n".join(chapters_text)
```

(`ebooklib` gives you the EPUB's internal XHTML chapter documents; you still need an HTML-to-text step — `BeautifulSoup(...).get_text()` or `lxml`'s own text extraction — since `ebooklib` itself only parses the EPUB container/OPF/spine structure, not prose out of the markup.)

### TXT / HTML (uploaded directly)

- **TXT**: trivial — decode bytes (try UTF-8, fall back to `chardet`/`charset_normalizer`, which is already a transitive dependency via `trafilatura`) — no extra library needed.
- **HTML** (uploaded file, as opposed to a fetched URL): reuse `trafilatura.extract()` directly on the raw HTML string (it accepts HTML content, not just a fetched URL) — same title+body extraction path as section 6, so no separate HTML-parsing dependency is needed for this case.

Sources: [pypdf · PyPI](https://pypi.org/project/pypdf/), [python-docx · PyPI](https://pypi.org/project/python-docx/), [ebooklib · PyPI](https://pypi.org/project/ebooklib/), [Is PyMuPDF Free for Commercial Use? The AGPL License Explained](https://www.file2markdown.ai/blog/is-pymupdf-free-for-commercial-use), [pypdf vs PyMuPDF: Speed, Quality, and the AGPL License Question](https://www.file2markdown.ai/blog/pypdf-vs-pymupdf), [PyMuPDF FAQ / licensing discussion #971](https://github.com/pymupdf/PyMuPDF/discussions/971).

---

## 8. Recommended dependency set (Python 3.12, versions as of 2026-09-26)

All versions below were read live from `https://pypi.org/pypi/<pkg>/json` today — re-check before pinning a lockfile, since some of these (`fastapi`, `pydantic`, `torch` itself) move fast.

```txt
# --- pip config: put the CPU torch index first so pip resolves the CPU-only build ---
# requirements.txt (pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu)

# TTS engine
torch==2.14.0+cpu            # from https://download.pytorch.org/whl/cpu — see Dockerfile note below
kokoro==0.9.4
misaki[en]==0.9.4
soundfile==0.14.0            # WAV/etc encode-decode
numpy>=1.26,<3               # kokoro/misaki/transformers don't pin this themselves — pin a broad-but-safe range and let the resolver settle a concrete version; verify against whatever numpy version transformers/spacy actually resolve to at build time, since numpy 2.5.x is very new

# API
fastapi==0.141.1
uvicorn[standard]==0.54.0
pydantic==2.13.5
python-multipart==0.0.32     # file uploads (PDF/DOCX/EPUB) via FastAPI's UploadFile
httpx==0.28.1                # outbound requests where needed (e.g. fetching a URL to hand to trafilatura)

# Text extraction — URL
trafilatura==2.2.0

# Text extraction — uploaded files
pypdf==6.19.0                 # PDF; add pymupdf==1.28.2 only as an explicit, license-flagged opt-in (AGPL-3.0)
python-docx==1.2.0            # DOCX
ebooklib==0.20                # EPUB
beautifulsoup4                # HTML-to-text helper for ebooklib chapters (pin alongside the above; version not separately researched here — check `pip index versions beautifulsoup4` at build time)

# --- optional, NOT installed by default ---
# kokoro-onnx==0.6.1          # lightweight/no-timestamp alternate engine mode
# pymupdf==1.28.2             # faster PDF, AGPL-3.0 — opt-in only, document the license implication where it's wired in
# newspaper4k==0.9.6          # only if trafilatura proves insufficient on a specific class of sites
```

Notable pin-compatibility caveats to actually verify once dependencies are locked (rather than assumed from this research pass):
- `kokoro==0.9.4` declares `requires_python: <3.13,>=3.10` — compatible with 3.12.10, but will need a version bump watch if the toolchain ever moves to 3.13+.
- `misaki[en]`'s `spacy`/`spacy-curated-transformers` deps have their own numpy/thinc/blis version constraints that can conflict with a very fresh `numpy` — running `pip install` (or `uv pip install`) with the full set and reading the resolver's actual output is more trustworthy than any pin asserted here from registry metadata alone.
- `onnxruntime` (if `kokoro-onnx` is later enabled) requires Python `>=3.11` per its own metadata — fine for 3.12, just note it if the project ever needs to run under an older interpreter for some other constraint.

---

## 9. Dockerfile base image strategy (CPU default, optional CUDA)

**CPU (default) image** — Debian slim base, no `apt-get install espeak-ng` needed (see §2), CPU-only torch index:

```dockerfile
FROM python:3.12-slim AS base

# System deps: only what's needed to build lxml/etc wheels if no prebuilt wheel matches;
# espeak-ng itself is NOT required for the English path (see research doc §2) —
# keep it commented as a documented fallback if a platform edge case needs it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      # espeak-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      -r requirements.txt

COPY api/ ./api/
# web/ build output copied here in the integration step (serves as static files — see project brief)
COPY --from=web-build /web/dist ./static/

EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Optional CUDA variant** — same Dockerfile, parameterized:

```dockerfile
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
FROM python:3.12-slim AS base
...
RUN pip install --no-cache-dir --extra-index-url ${TORCH_INDEX} -r requirements.txt
```

built with `docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu128 .` (check the current CUDA channel name at build time against `https://download.pytorch.org/whl/`, since PyTorch rotates supported CUDA versions across releases — `cu128`/`cu126`/etc. as of this research pass, but don't hardcode from memory when actually building). A CUDA image needs the corresponding NVIDIA Container Toolkit on the host and a matching base (or `nvidia/cuda`-derived) image if you want the CUDA *runtime* libraries baked in rather than relying purely on the `nvidia-*` pip wheels — that's a separate decision from the Python dependency question this research focused on, and should be scoped explicitly if/when Tamber actually ships a GPU image.

**Rough image-size budgeting** (Python/ML deps only, before app code/web static assets):
- CPU image: `torch+cpu` (~196 MB) + `transformers`/`spacy`/`misaki` deps + Kokoro model weights (~80–330 MB depending on precision, downloaded at runtime into a cache volume rather than baked into the image, per §1.6) + `onnxruntime`-free — a few hundred MB to ~1 GB total for the Python layer, well short of the multi-GB CUDA-bundled default.
- If `kokoro-onnx` were used instead (no PyTorch at all): `onnxruntime` CPU wheel is only 23.6 MB — dramatically smaller, reinforcing that it's the right call for a hypothetical future "lightweight mode," just not for v1 given the timestamp requirement.

---

## Appendix: primary sources consulted

- [`hexgrad/kokoro` GitHub repo](https://github.com/hexgrad/kokoro) — [`pipeline.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py), [`model.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/model.py), [README](https://github.com/hexgrad/kokoro/blob/main/README.md)
- [`hexgrad/misaki` GitHub repo](https://github.com/hexgrad/misaki) — [`token.py`](https://github.com/hexgrad/misaki/blob/main/misaki/token.py), [`espeak.py`](https://github.com/hexgrad/misaki/blob/main/misaki/espeak.py), [`en.py`](https://github.com/hexgrad/misaki/blob/main/misaki/en.py)
- [`hexgrad/Kokoro-82M` on Hugging Face](https://huggingface.co/hexgrad/Kokoro-82M), [`VOICES.md`](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [`thewh1teagle/kokoro-onnx` GitHub repo](https://github.com/thewh1teagle/kokoro-onnx) — [README](https://github.com/thewh1teagle/kokoro-onnx/blob/main/README.md), [`__init__.py`](https://github.com/thewh1teagle/kokoro-onnx/blob/main/src/kokoro_onnx/__init__.py)
- PyPI JSON API (`https://pypi.org/pypi/<package>/json`) for every version number in this document: `kokoro`, `misaki`, `kokoro-onnx`, `torch`, `onnxruntime`, `onnxruntime-gpu`, `fastapi`, `uvicorn`, `pydantic`, `python-multipart`, `httpx`, `pypdf`, `pymupdf`, `python-docx`, `ebooklib`, `trafilatura`, `readability-lxml`, `newspaper4k`, `espeakng-loader`, `huggingface-hub`, `loguru`, `transformers`, `soundfile`, `phonemizer`, `phonemizer-fork`, `spacy`, `pyopenjtalk`, `fugashi`, `pypinyin`
- [`download.pytorch.org/whl/cpu`](https://download.pytorch.org/whl/cpu/torch/) — direct index listing + `HEAD` request for the exact `torch-2.14.0+cpu` Linux x86_64 wheel size
- [remsky/Kokoro-FastAPI GitHub repo](https://github.com/remsky/Kokoro-FastAPI) and its [DeepWiki streaming/performance page](https://deepwiki.com/remsky/Kokoro-FastAPI/7.2-streaming-and-performance-optimization) — for the CPU/GPU latency figures and to understand the prior art this project explicitly supersedes
- [Trafilatura evaluation docs](https://trafilatura.readthedocs.io/en/latest/evaluation.html) and [contextractor's independent comparison](https://www.contextractor.com/trafilatura-vs-readability-vs-newspaper/) — extraction accuracy figures
- [file2markdown.ai's PyMuPDF licensing write-ups](https://www.file2markdown.ai/blog/is-pymupdf-free-for-commercial-use) and [PyMuPDF GitHub discussion #971](https://github.com/pymupdf/PyMuPDF/discussions/971) — AGPL/commercial licensing confirmation

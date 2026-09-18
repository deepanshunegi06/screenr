"""Chunk retrieval for rubric and resume lookups.

Embeddings run locally via fastembed -- no API key, no per-call cost. The model
is loaded once, lazily, so importing this module stays cheap and tests that never
retrieve never pay for it.
"""

from __future__ import annotations

import math
import re
from functools import lru_cache


@lru_cache(maxsize=1)
def _embedder():
    from fastembed import TextEmbedding

    return TextEmbedding(model_name="BAAI/bge-small-en-v1.5")


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _keyword_score(chunk: str, query: str) -> float:
    """Fallback when embeddings are unavailable (offline CI, cold container)."""
    tokens = set(re.findall(r"[a-z0-9]+", query.lower()))
    if not tokens:
        return 0.0
    words = set(re.findall(r"[a-z0-9]+", chunk.lower()))
    return len(tokens & words) / len(tokens)


def search(chunks: list[str], query: str, k: int = 3) -> list[str]:
    """Return the k chunks most relevant to query, best first."""
    if not chunks:
        return []
    k = min(k, len(chunks))

    try:
        vectors = [list(v) for v in _embedder().embed([query, *chunks])]
        qv, cvs = vectors[0], vectors[1:]
        ranked = sorted(zip(chunks, cvs, strict=True), key=lambda p: _cosine(qv, p[1]), reverse=True)
        return [c for c, _ in ranked[:k]]
    except Exception:
        # ponytail: keyword fallback keeps the agent answering when the embedding
        # model cannot load. Swap for a hard failure if retrieval quality becomes
        # load-bearing for scoring.
        ranked = sorted(chunks, key=lambda c: _keyword_score(c, query), reverse=True)
        return ranked[:k]


def chunk_text(text: str, target_chars: int = 500) -> list[str]:
    """Split on blank lines, then pack paragraphs up to target_chars."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for p in paragraphs:
        if buf and len(buf) + len(p) + 2 > target_chars:
            chunks.append(buf)
            buf = p
        else:
            buf = f"{buf}\n\n{p}" if buf else p
    if buf:
        chunks.append(buf)
    return chunks

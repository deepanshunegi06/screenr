"""Turning a résumé file into text.

Recruiters have PDFs and Word documents, not plain text in a clipboard. This
takes the file, pulls the words out, and throws the file away -- nothing is
stored. What the interview needs is the text: the claims to probe and something
to check answers against.
"""

from __future__ import annotations

import io
import re
import zipfile

from pypdf import PdfReader

MAX_BYTES = 5 * 1024 * 1024
MAX_CHARS = 20000

SUPPORTED = {".pdf", ".docx", ".txt", ".md"}

# Word stores its text in XML; the paragraphs are what matter, the styling is not.
_TAG = re.compile(r"<[^>]+>")
_PARAGRAPH_END = re.compile(r"</w:p>")


def _from_pdf(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _from_docx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        xml = archive.read("word/document.xml").decode("utf-8", "replace")
    # Paragraph boundaries have to survive, or every bullet runs into the next
    # and claim extraction sees one enormous line.
    return _TAG.sub("", _PARAGRAPH_END.sub("\n", xml))


def tidy(text: str) -> str:
    """Collapse the whitespace a PDF extractor leaves behind, keep the lines.

    Line structure is what claim extraction reads -- one bullet, one claim -- so
    blank runs collapse but newlines stay.
    """
    lines = [re.sub(r"[ \t ]+", " ", line).strip() for line in text.splitlines()]
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()[:MAX_CHARS]


def extract(filename: str, data: bytes) -> str:
    """Text from a résumé file. Raises ValueError with something a person can act on."""
    if len(data) > MAX_BYTES:
        raise ValueError("That file is larger than 5 MB.")

    suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in SUPPORTED:
        raise ValueError("Upload a PDF, Word document, or text file.")

    try:
        if suffix == ".pdf":
            text = _from_pdf(data)
        elif suffix == ".docx":
            text = _from_docx(data)
        else:
            text = data.decode("utf-8", "replace")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("Couldn't read that file. It may be corrupt or password-protected.") from exc

    text = tidy(text)
    if len(text) < 40:
        # Almost always a scanned résumé: a PDF of photographs of text.
        raise ValueError(
            "No text found in that file. If it's a scan, paste the text instead."
        )
    return text


def guess_name(text: str) -> str:
    """The candidate's name, if the résumé opens the way résumés usually do.

    Saves the recruiter typing it. Wrong is harmless -- the field stays editable.
    """
    for line in text.splitlines()[:5]:
        line = line.strip(" \t-|,")
        if not 3 < len(line) < 45 or "@" in line or any(c.isdigit() for c in line):
            continue
        words = line.split()
        if 1 < len(words) <= 4 and all(w[:1].isupper() for w in words if w):
            return line
    return ""

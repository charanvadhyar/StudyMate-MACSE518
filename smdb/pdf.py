"""PDF textbook -> section-aware chunks.

Works on PDFs that carry real text (not scans). Structure comes from the PDF's own outline
(table of contents) when it has one, and from font size / weight otherwise.

Each chunk
  * stays inside one section (never crosses a heading),
  * is built from whole paragraphs, packed up to `target_words` (long paragraphs are split at
    sentence ends; code and other monospaced blocks are kept whole),
  * carries its chapter, its full section path, its page range and a `kind`:
      body       ordinary text - what retrieval should search
      exercise   review questions / exercises
      reference  bibliography, footnotes, index, preface, copyright (not indexed by default)

`Chunk.indexed_text()` is what gets encoded: the section path followed by the text, so a chunk
that says "it uses two phases" still matches a question about two-phase locking.

    python -m smdb.pdf books/book.pdf --out data/chunks/book.jsonl

ColBERT encodes at most 300 word pieces per chunk, so the default target (160 words) leaves room
for the section path.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path

EXERCISE = re.compile(r"^(review questions?|exercises?|problems?|lab(oratory)? exercises?|"
                      r"multiple[- ]choice questions?|short answer.*)$", re.I)
REFERENCE = re.compile(r"^(selected bibliography|bibliograph(y|ic notes?)|references?|footnotes?|"
                       r"further reading|notes|index|preface|foreword|acknowledge?ments?|"
                       r"about the authors?|copyright.*|contents.*|table of contents|"
                       r"guidelines for using this book|glossary)$", re.I)
SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]*\s+(?=[\"'(\[]?[A-Z0-9])")


@dataclass
class Line:
    page: int          # 1-based
    y: float
    x: float
    text: str
    size: float
    bold: bool
    mono: bool


@dataclass
class Chunk:
    doc_id: str
    book: str
    kind: str
    chapter: str
    section_path: list[str]
    page_start: int
    page_end: int
    text: str
    words: int = field(default=0)

    def indexed_text(self) -> str:
        head = " > ".join(self.section_path[-3:])
        return f"{head}. {self.text}" if head else self.text


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _read_lines(doc) -> list[Line]:
    lines: list[Line] = []
    for pno in range(doc.page_count):
        page = doc[pno]
        height = page.rect.height
        for block in page.get_text("dict")["blocks"]:
            for ln in block.get("lines", []):
                spans = [s for s in ln["spans"] if s["text"].strip()]
                text = "".join(s["text"] for s in ln["spans"]).replace(" ", " ").strip()
                if not spans or not text:
                    continue
                chars = sum(len(s["text"]) for s in spans)
                bold = sum(len(s["text"]) for s in spans
                           if s["flags"] & 16 or "bold" in s["font"].lower()) > 0.6 * chars
                mono = sum(len(s["text"]) for s in spans
                           if s["flags"] & 8 or "courier" in s["font"].lower()
                           or "mono" in s["font"].lower()) > 0.6 * chars
                size = max(spans, key=lambda s: len(s["text"]))["size"]
                y, x = ln["bbox"][1], ln["bbox"][0]
                lines.append(Line(pno + 1, y / height, x, text, round(size, 1), bold, mono))
    lines.sort(key=lambda l: (l.page, round(l.y, 3), l.x))
    return lines


def _drop_running_text(lines: list[Line], n_pages: int) -> list[Line]:
    """Remove page headers / footers: text in the top or bottom band of the page that repeats
    (digits ignored) on many pages."""
    band = [l for l in lines if l.y < 0.07 or l.y > 0.92]
    seen = Counter(re.sub(r"\d+", "#", l.text) for l in band)
    repeated = {k for k, n in seen.items() if n >= max(3, n_pages // 20)}
    out = []
    for l in lines:
        if (l.y < 0.07 or l.y > 0.92) and (re.sub(r"\d+", "#", l.text) in repeated
                                           or re.fullmatch(r"[\divxlc]{1,4}", l.text, re.I)):
            continue
        out.append(l)
    return out


def _headings_from_outline(doc, lines: list[Line]):
    """Place every outline (table of contents) entry in the line stream.

    The outline is the source of truth for the section hierarchy; the page text only tells us
    where on its page each entry starts. A title may be printed on one line or wrapped over up
    to three; if it cannot be found, the entry starts at the top of its page.

    Returns (cuts, drop): cuts[i] = list of (level, title) that begin at line i; drop = lines
    that are heading text or merely repeat an outline title (the "in this section" lists some
    books print under a heading)."""
    toc = [(lvl, re.sub(r"\s+", " ", title).strip(), page)
           for lvl, title, page in doc.get_toc() if title.strip()]
    body = statistics.mode([l.size for l in lines])
    first_on_page: dict[int, int] = {}
    for i, l in enumerate(lines):
        first_on_page.setdefault(l.page, i)
    pages = sorted(first_on_page)
    cuts: dict[int, list[tuple[int, str]]] = {}
    drop: set[int] = set()
    pos = 0
    for lvl, title, page in toc:
        key = _norm(title)
        start = first_on_page.get(page)
        if start is None:                                   # page without text: next page that has some
            start = next((first_on_page[p] for p in pages if p >= page), len(lines) - 1)
        start = max(start, pos)
        found = None
        i = start
        while i < len(lines) and lines[i].page <= max(page, lines[start].page):
            l = lines[i]
            if l.bold or l.size > body + 0.5:
                acc = ""
                for j in range(i, min(i + 3, len(lines))):
                    if not (lines[j].bold or lines[j].size > body + 0.5):
                        break
                    acc = (acc + " " + lines[j].text).strip()
                    if _norm(acc) == key:
                        found = (i, j)
                        break
                    if not key.startswith(_norm(acc)):
                        break
                if found:
                    break
            i += 1
        if found:
            at = found[0]
            drop.update(range(found[0], found[1] + 1))
            pos = found[1] + 1
        else:
            at = start
        cuts.setdefault(at, []).append((lvl, title))
    titles = {_norm(t) for _, t, _ in toc if len(_norm(t)) > 3}
    for i, l in enumerate(lines):
        if i not in drop and len(l.text) < 120 and _norm(l.text) in titles \
                and not (l.bold or l.size > body + 0.5):
            drop.add(i)
    return cuts, drop


def _headings_from_fonts(lines: list[Line]):
    """No outline: a heading is a short line that is larger than body text, or bold and alone."""
    body = statistics.mode([l.size for l in lines])
    sizes = sorted({l.size for l in lines if l.size > body + 0.5}, reverse=True)[:3]
    cuts: dict[int, list[tuple[int, str]]] = {}
    for i, l in enumerate(lines):
        if len(l.text) > 110 or l.text.endswith((".", ",", ";", ":")):
            continue
        if l.size in sizes:
            cuts[i] = [(sizes.index(l.size) + 1, l.text)]
        elif l.bold and l.size >= body and re.match(r"^(\d+(\.\d+)*\.?|chapter|appendix|part)\s", l.text, re.I):
            cuts[i] = [(len(sizes) + 1 + l.text.split()[0].count("."), l.text)]
    return cuts, set(cuts)


def _paragraphs(lines: list[Line]) -> list[tuple[str, int, int, bool]]:
    """Group consecutive lines into paragraphs: (text, first page, last page, is_code)."""
    if not lines:
        return []
    gaps = [b.y - a.y for a, b in zip(lines, lines[1:]) if a.page == b.page and 0 < b.y - a.y < 0.05]
    step = statistics.median(gaps) if gaps else 0.014
    out: list[tuple[str, int, int, bool]] = []
    cur: list[Line] = []

    def flush():
        if not cur:
            return
        code = sum(l.mono for l in cur) > len(cur) / 2
        if code:
            text = "\n".join(l.text for l in cur)
        else:
            text = " ".join(l.text for l in cur)
            text = re.sub(r"\s+", " ", text).strip()
            text = re.sub(r"^[•●▪–*-]\s*", "", text)
        if text:
            out.append((text, cur[0].page, cur[-1].page, code))
        cur.clear()

    for l in lines:
        if cur:
            p = cur[-1]
            same_page = l.page == p.page
            gap = (l.y - p.y) if same_page else 0.0
            bullet = bool(re.match(r"^[•●▪]", l.text))
            # a new paragraph starts after a vertical gap, at a bullet, or when the text style flips
            # between prose and code; a page break alone does not end a paragraph
            if (same_page and gap > 1.6 * step) or bullet or l.mono != p.mono:
                flush()
            elif not same_page and p.text.rstrip().endswith((".", ":", "?", "!")):
                flush()
        cur.append(l)
    flush()
    return out


def _split_long(text: str, limit: int) -> list[str]:
    words = text.split()
    if len(words) <= limit:
        return [text]
    parts, cur, n = [], [], 0
    for sent in SENTENCE_END.split(text):
        w = len(sent.split())
        if cur and n + w > limit:
            parts.append(" ".join(cur)); cur, n = [], 0
        while w > limit:                       # a single enormous sentence: cut by words
            sw = sent.split()
            parts.append(" ".join(sw[:limit])); sent = " ".join(sw[limit:]); w = len(sent.split())
        cur.append(sent); n += w
    if cur:
        parts.append(" ".join(cur))
    return parts


def _kind(path: list[str]) -> str:
    for title in reversed(path):
        t = re.sub(r"^[\d.\s]+", "", title).strip()
        if REFERENCE.match(t) or re.fullmatch(r"[A-Z]", t):
            return "reference"
        if EXERCISE.match(t):
            return "exercise"
    return "body"


def extract(path: str | Path, book: str | None = None, target_words: int = 160,
            max_words: int = 200, min_words: int = 25) -> list[Chunk]:
    """Read a PDF and return its chunks in reading order."""
    import pymupdf

    path = Path(path)
    book = book or re.sub(r"[^a-z0-9]+", "-", path.stem.lower()).strip("-")[:40]
    doc = pymupdf.open(path)
    lines = _drop_running_text(_read_lines(doc), doc.page_count)
    if not lines:
        raise ValueError(f"{path.name}: no text found - the PDF is probably scanned and needs OCR first")
    if len(doc.get_toc()) >= 5:
        cuts, drop = _headings_from_outline(doc, lines)
    else:
        cuts, drop = _headings_from_fonts(lines)

    # walk the lines, keeping the current section path, and cut a section at every heading
    sections: list[tuple[list[str], list[Line]]] = []
    path_now: list[tuple[int, str]] = []
    cur: list[Line] = []
    for i, l in enumerate(lines):
        if i in cuts:
            if cur:
                sections.append(([t for _, t in path_now], cur)); cur = []
            for lvl, title in cuts[i]:
                path_now = [(a, t) for a, t in path_now if a < lvl] + [(lvl, title)]
        if i not in drop:
            cur.append(l)
    if cur:
        sections.append(([t for _, t in path_now], cur))

    chunks: list[Chunk] = []

    def emit(sec_path, kind, pieces):
        if not pieces:
            return
        text = "\n\n".join(p[0] for p in pieces)
        chapter = next((t for t in sec_path if re.match(r"^(chapter|appendix)\b", t, re.I)),
                       sec_path[0] if sec_path else "")
        chunks.append(Chunk(f"{book}:{len(chunks):05d}", book, kind, chapter, list(sec_path),
                            min(p[1] for p in pieces), max(p[2] for p in pieces), text, len(text.split())))

    for sec_path, sec_lines in sections:
        kind = _kind(sec_path)
        pieces: list[tuple[str, int, int]] = []
        n = 0
        for text, p0, p1, code in _paragraphs(sec_lines):
            parts = [text] if code else _split_long(text, max_words)
            for part in parts:
                w = len(part.split())
                if pieces and n + w > target_words and n >= min_words:
                    emit(sec_path, kind, pieces); pieces, n = [], 0
                pieces.append((part, p0, p1)); n += w
        if pieces:
            # a tiny tail joins the previous chunk of the same section instead of standing alone
            if n < min_words and chunks and chunks[-1].section_path == list(sec_path) \
                    and chunks[-1].words + n <= max_words + min_words:
                last = chunks[-1]
                last.text += "\n\n" + "\n\n".join(p[0] for p in pieces)
                last.page_end = max(last.page_end, max(p[2] for p in pieces))
                last.words = len(last.text.split())
            else:
                emit(sec_path, kind, pieces)
    return chunks


def summary(chunks: list[Chunk]) -> str:
    kinds = Counter(c.kind for c in chunks)
    words = [c.words for c in chunks if c.kind == "body"] or [0]
    chapters = len({c.chapter for c in chunks if c.kind == "body"})
    return (f"{len(chunks):,} chunks ({kinds['body']:,} body, {kinds['exercise']:,} exercise, "
            f"{kinds['reference']:,} reference) in {chapters} chapters; body chunks: median "
            f"{statistics.median(words):.0f} words, max {max(words)}, "
            f"{sum(w < 40 for w in words)} under 40 words")


def main() -> None:
    ap = argparse.ArgumentParser(description="PDF textbook -> section-aware chunks (JSON lines)")
    ap.add_argument("pdf")
    ap.add_argument("--out", help="default: data/chunks/<book>.jsonl")
    ap.add_argument("--book", help="short id used in chunk ids (default: from the file name)")
    ap.add_argument("--target-words", type=int, default=160)
    ap.add_argument("--max-words", type=int, default=200)
    args = ap.parse_args()
    chunks = extract(args.pdf, args.book, args.target_words, args.max_words)
    out = Path(args.out) if args.out else Path("data/chunks") / f"{chunks[0].book}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(asdict(c), ensure_ascii=False) + "\n")
    print(summary(chunks))
    print(f"saved {out}")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()

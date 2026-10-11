"""PDF extraction: builds a small textbook-like PDF on the fly (needs pymupdf)."""
import pytest

pymupdf = pytest.importorskip("pymupdf")

from smdb.pdf import extract  # noqa: E402

PARA = ("A transaction is a logical unit of database processing that includes one or more access "
        "operations. Concurrency control techniques ensure that transactions do not interfere. ")


def _make(path, outline=True):
    doc = pymupdf.open()
    toc = []
    spec = [
        ("Chapter 1: Transactions", 1, [("1.1 Introduction", 6), ("1.2 Locking", 24), ("Exercises", 2)]),
        ("Chapter 2: Recovery", 1, [("2.1 Logging", 5), ("Selected Bibliography", 2)]),
    ]
    for chapter, _, sections in spec:
        page = doc.new_page()
        y = 72
        page.insert_text((72, y), chapter, fontsize=18, fontname="hebo")
        toc.append([1, chapter, doc.page_count])
        y += 30
        for title, n_para in sections:
            if y > 700:
                page = doc.new_page(); y = 72
            page.insert_text((72, y), title, fontsize=13, fontname="hebo")
            toc.append([2, title, doc.page_count])
            y += 22
            for k in range(n_para):
                for line in [PARA[i:i + 90] for i in range(0, len(PARA), 90)] * 2:
                    if y > 760:
                        page = doc.new_page(); y = 72
                    page.insert_text((72, y), f"{line}", fontsize=10, fontname="helv")
                    y += 12
                y += 14
        for p in doc:
            pass
    for i, p in enumerate(doc):
        p.insert_text((260, 820), f"Page {i + 1} of {doc.page_count}", fontsize=8, fontname="helv")
    if outline:
        doc.set_toc(toc)
    doc.save(path)


@pytest.mark.parametrize("outline", [True, False])
def test_chunks_follow_sections_and_pages(tmp_path, outline):
    pdf = tmp_path / "Mini Book.pdf"
    _make(str(pdf), outline)
    chunks = extract(pdf, target_words=80, max_words=120)
    assert chunks and all(c.doc_id.startswith("mini-book:") for c in chunks)
    kinds = {c.section_path[-1]: c.kind for c in chunks}
    assert kinds["1.2 Locking"] == "body"
    assert kinds["Exercises"] == "exercise" and kinds["Selected Bibliography"] == "reference"
    lock = [c for c in chunks if c.section_path[-1] == "1.2 Locking"]
    assert len(lock) > 1                                             # a long section is split ...
    assert all(c.words <= 120 + 25 for c in chunks)                  # ... into bounded chunks
    assert all(c.chapter == "Chapter 1: Transactions" for c in lock)
    assert all(c.section_path[0] == "Chapter 2: Recovery" for c in chunks if c.section_path[-1] == "2.1 Logging")
    assert all("Page " not in c.text and "1.2 Locking" not in c.text for c in chunks)   # no footers, no heading text
    assert all(1 <= c.page_start <= c.page_end for c in chunks)
    assert [c.page_start for c in chunks] == sorted(c.page_start for c in chunks)
    assert lock[0].indexed_text().startswith("Chapter 1: Transactions > 1.2 Locking. ")

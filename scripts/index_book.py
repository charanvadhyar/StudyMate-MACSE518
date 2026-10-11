"""Index a PDF textbook and ask it questions.

  python -u scripts/index_book.py "books/My Book.pdf" --ask "what is two-phase locking?" "define a foreign key"
  python -u scripts/index_book.py "books/My Book.pdf"          # then type questions

Steps: extract section-aware chunks (smdb.pdf) -> encode the body chunks with a ColBERT model ->
train the quantizer on this book's own vectors -> build the index (centroid pooling) -> search.
Chunks, vectors and the quantizer are cached under data/, so only the first run is slow.
The index here lives in memory; pass --store cassandra to write it to a cluster instead.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from smdb.config import IndexConfig                    # noqa: E402
from smdb.index import Index                           # noqa: E402
from smdb.pdf import Chunk, extract, summary           # noqa: E402
from smdb.quantizer import Quantizer                   # noqa: E402
from smdb.store import MemoryStore                     # noqa: E402

SMALL = "answerdotai/answerai-colbert-small-v1"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--ask", nargs="*", help="questions; omit to type them interactively")
    ap.add_argument("--book", help="short id for the book (default: from the file name)")
    ap.add_argument("--model", default=SMALL)
    ap.add_argument("--encoder", choices=["colbert", "hash"], default="colbert",
                    help="hash = no model download, wiring test only (results are meaningless)")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--kinds", nargs="*", default=["body"], help="chunk kinds to index")
    ap.add_argument("--k-ivf", type=int, help="centroids (default: chosen from the corpus size)")
    ap.add_argument("--trainer", choices=["sklearn", "faiss"], default="faiss")
    ap.add_argument("--nprobe", type=int, default=4)
    ap.add_argument("--rerank", type=int, default=20)
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--store", choices=["memory", "cassandra"], default="memory")
    ap.add_argument("--port", type=int, default=9042)
    ap.add_argument("--keyspace", default="smdb_books")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    # ---- 1. chunks
    t = time.perf_counter()
    chunks = extract(args.pdf, args.book)
    book = chunks[0].book
    out = Path("data/chunks") / f"{book}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(json.dumps(asdict(c), ensure_ascii=False) for c in chunks) + "\n", encoding="utf-8")
    print(f"{Path(args.pdf).name}: {summary(chunks)}  ({time.perf_counter() - t:.1f}s) -> {out}")
    use = [c for c in chunks if c.kind in args.kinds]
    by_id: dict[str, Chunk] = {c.doc_id: c for c in use}

    # ---- 2. token vectors
    if args.encoder == "hash":
        from smdb.encoder import HashEncoder
        enc, tag = HashEncoder(96), "hash"
    else:
        from smdb.encoder import ColbertEncoder, model_tag
        enc, tag = ColbertEncoder(args.model, device=args.device, markers="colbert"), model_tag(args.model)
    cache = Path("data") / f"book_{book}_{tag}_{len(use)}.npz"
    if cache.exists():
        z = np.load(cache)
        vecs = np.split(z["vecs"], np.cumsum(z["lens"])[:-1])
        print(f"vectors: loaded {cache}")
    else:
        from tqdm import tqdm
        t = time.perf_counter()
        vecs = []
        texts = [c.indexed_text() for c in use]
        for s in tqdm(range(0, len(texts), 16), desc="encode chunks"):
            vecs.extend(enc.encode_docs(texts[s:s + 16]))
        np.savez(cache, vecs=np.concatenate(vecs), lens=np.array([len(v) for v in vecs]))
        dt = time.perf_counter() - t
        print(f"vectors: encoded {len(use):,} chunks in {dt:.0f}s ({len(use) / dt:.1f} chunks/s) -> {cache}")
    n_vec = sum(len(v) for v in vecs)
    dim = vecs[0].shape[1]

    # ---- 3. quantizer trained on this book
    k_ivf = args.k_ivf or int(min(4096, max(64, 2 ** round(np.log2(4 * np.sqrt(n_vec))))))
    qpath = Path("data") / f"quantizer_book_{book}_{tag}_{k_ivf}.npz"
    if qpath.exists():
        quant = Quantizer.load(str(qpath))
    else:
        t = time.perf_counter()
        trainer = args.trainer
        if trainer == "faiss":
            try:
                import faiss  # noqa: F401
            except ImportError:
                trainer = "sklearn"
        quant = Quantizer.train(np.concatenate(vecs), IndexConfig(dim=dim, k_ivf=k_ivf, m_pq=32),
                                trainer=trainer, verbose=True)
        quant.save(str(qpath))
        print(f"quantizer: {k_ivf} centroids trained in {time.perf_counter() - t:.0f}s")

    # ---- 4. index
    if args.store == "cassandra":
        from smdb.store import CassandraStore
        store = CassandraStore(port=args.port, keyspace=args.keyspace)
    else:
        store = MemoryStore()
    index = Index(store, quant, encoder=enc, pool="centroid")
    scope = f"book:{book}:{tag}"
    t = time.perf_counter()
    items = [(c.doc_id, *index.quantize(v)) for c, v in zip(use, vecs) if len(v)]
    stored = sum(len(c) for _, c, _ in items)
    if int(store.partition_sizes(quant.cfg, scope).sum()) != stored:
        for s in range(0, len(items), 256):
            store.write_docs(quant.cfg, scope, items[s:s + 256])
    print(f"index: {len(items):,} chunks, {n_vec:,} token vectors -> {stored:,} stored "
          f"({stored * (2 + 2 * quant.cfg.m_pq) / len(items):,.0f} bytes per chunk), "
          f"{time.perf_counter() - t:.0f}s")

    # ---- 5. questions
    def ask(q: str) -> None:
        t0 = time.perf_counter()
        res, st = index.search_text(scope, q, args.top, planner="fixed", nprobe=args.nprobe, rerank=args.rerank)
        ms = (time.perf_counter() - t0) * 1e3
        print(f"\nQ: {q}\n   ({ms:.0f} ms incl. encoding the question; {st.partitions_read} partitions, "
              f"{st.reranked} chunks rescored)")
        for rank, r in enumerate(res, 1):
            c = by_id[r.doc_id]
            pages = f"p.{c.page_start}" if c.page_start == c.page_end else f"pp.{c.page_start}-{c.page_end}"
            print(f" {rank}. [{r.score:.2f}] {' > '.join(c.section_path[-2:])}  ({pages})")
            text = " ".join(c.text.split())
            print(f"    {text[:420]}{'...' if len(text) > 420 else ''}")

    if args.ask:
        for q in args.ask:
            ask(q)
    else:
        print("\ntype a question (empty line to quit)")
        while True:
            try:
                q = input("> ").strip()
            except EOFError:
                break
            if not q:
                break
            ask(q)


if __name__ == "__main__":
    main()

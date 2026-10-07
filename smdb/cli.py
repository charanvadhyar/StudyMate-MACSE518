"""Command line helpers.

  python -m smdb.cli init                      create keyspace and tables
  python -m smdb.cli train --vectors v.npy     train a quantizer and store it
  python -m smdb.cli info                      show the stored index configuration

`--vectors` is a float32 .npy of token vectors [n, dim] sampled from the corpus the
index will hold (a few hundred thousand tokens is enough).
"""
from __future__ import annotations

import argparse

import numpy as np

from .config import IndexConfig
from .quantizer import Quantizer


def _store(args):
    from .store import CassandraStore
    return CassandraStore(contact_points=args.hosts.split(","), port=args.port,
                          keyspace=args.keyspace, local_dc=args.dc)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="smdb")
    ap.add_argument("--hosts", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9042)
    ap.add_argument("--keyspace", default="smdb")
    ap.add_argument("--dc", default="datacenter1")
    ap.add_argument("--index-id", default="default")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("info")
    t = sub.add_parser("train")
    t.add_argument("--vectors", required=True)
    t.add_argument("--k-ivf", type=int, default=1024)
    t.add_argument("--m-pq", type=int, default=32)
    t.add_argument("--buckets", type=int, default=1)
    t.add_argument("--sample", type=int, default=200_000)
    t.add_argument("--out", help="also save the quantizer to this .npz file")
    args = ap.parse_args(argv)

    if args.cmd == "init":
        _store(args).close()
        print(f"keyspace {args.keyspace!r} and tables are ready")
    elif args.cmd == "info":
        store = _store(args)
        q = store.load_quantizer(args.index_id)
        print("no quantizer stored" if q is None else q.cfg)
        store.close()
    elif args.cmd == "train":
        vectors = np.load(args.vectors)
        cfg = IndexConfig(dim=vectors.shape[1], k_ivf=args.k_ivf, m_pq=args.m_pq,
                          n_buckets=args.buckets)
        q = Quantizer.train(vectors, cfg, sample_size=args.sample, verbose=True)
        if args.out:
            q.save(args.out)
        store = _store(args)
        store.save_quantizer(args.index_id, q)
        store.close()
        print(f"stored quantizer {args.index_id!r}: {cfg}")


if __name__ == "__main__":
    main()

"""Core tests on synthetic vectors.

By default they run against the in-memory store. To run the same store and search
tests against a live Cassandra:   SMDB_TEST_CASSANDRA=127.0.0.1 pytest
"""
import os
import uuid

import numpy as np
import pytest

from smdb import Index, IndexConfig, Quantizer
from smdb import planner as P
from smdb.eval import ExactCorpus, ndcg_at_k, overlap_at_k
from smdb.scorer import HAVE_KERNEL, maxsim_by_group, pq_scores, pq_scores_numpy
from smdb.store import MemoryStore

CFG = IndexConfig(dim=32, k_ivf=24, m_pq=8, k_pq=256, n_buckets=1)


def _corpus(n_docs=150, seed=0):
    rng = np.random.default_rng(seed)
    centers = rng.standard_normal((30, CFG.dim)).astype(np.float32)
    docs = []
    for _ in range(n_docs):
        t = rng.choice(30, 4, replace=False)
        v = centers[rng.choice(t, int(rng.integers(8, 40)))]
        v = v + 0.5 * rng.standard_normal(v.shape).astype(np.float32)
        docs.append(v / np.linalg.norm(v, axis=1, keepdims=True))
    queries = [docs[i][:6] + 0.05 * rng.standard_normal((6, CFG.dim)).astype(np.float32)
               for i in range(0, 40, 4)]
    return [f"doc{i}" for i in range(n_docs)], docs, queries


@pytest.fixture(scope="module")
def data():
    ids, docs, queries = _corpus()
    quant = Quantizer.train(np.concatenate(docs), CFG, n_init=1, max_iter=30)
    return ids, docs, queries, quant


def _stores():
    out = ["memory"]
    if os.getenv("SMDB_TEST_CASSANDRA"):
        out.append("cassandra")
    return out


@pytest.fixture(params=_stores())
def store(request):
    if request.param == "memory":
        yield MemoryStore()
    else:
        from smdb.store import CassandraStore
        s = CassandraStore(contact_points=os.environ["SMDB_TEST_CASSANDRA"].split(","),
                           keyspace="smdb_test")
        yield s
        s.close()


def _load(store, data, cfg_quant=None):
    ids, docs, queries, quant = data
    quant = cfg_quant or quant
    scope = f"t-{uuid.uuid4().hex[:10]}"      # fresh scope per test, also on a shared cluster
    index = Index(store, quant, sizes_ttl_s=0)
    for d, v in zip(ids, docs):
        index.add(scope, d, v, replace=False)
    return index, scope


def _reference(quant, docs, q):
    """Full PQ-approximate MaxSim computed the slow, obvious way."""
    out = []
    for v in docs:
        cids, codes = quant.encode(v)
        out.append(float((q @ quant.decode(cids, codes).T).max(axis=1).sum()))
    return np.array(out)


# ------------------------------------------------------------------ quantizer
def test_quantizer_reduces_error_and_roundtrips(data, tmp_path):
    _, docs, _, quant = data
    v = np.concatenate(docs)
    cids, codes = quant.encode(v)
    assert cids.dtype == np.uint16 and codes.shape == (len(v), CFG.m_pq)
    err_pq = np.linalg.norm(v - quant.decode(cids, codes), axis=1).mean()
    err_ivf = np.linalg.norm(v - quant.centroids[cids], axis=1).mean()
    assert err_pq < err_ivf < 1.0
    assert Quantizer.from_bytes(CFG, *quant.to_bytes()) == quant
    quant.save(str(tmp_path / "q.npz"))
    assert Quantizer.load(str(tmp_path / "q.npz")) == quant


def test_scores_match_decoded_dot_product(data):
    _, docs, queries, quant = data
    q, v = queries[0], docs[3]
    cids, codes = quant.encode(v)
    approx = pq_scores(quant.residual_luts(q), codes) + quant.centroid_scores(q)[:, cids]
    np.testing.assert_allclose(approx, q @ quant.decode(cids, codes).T, atol=1e-4)


@pytest.mark.skipif(not HAVE_KERNEL, reason="colvec_kernel not built")
def test_rust_kernel_matches_numpy():
    rng = np.random.default_rng(1)
    luts = rng.standard_normal((7, 8, 256)).astype(np.float32)
    for n in (1, 7, 8, 9, 1000):
        codes = rng.integers(0, 256, (n, 8), dtype=np.uint8)
        np.testing.assert_allclose(pq_scores(luts, codes, use_kernel=True),
                                   pq_scores_numpy(luts, codes), atol=1e-4)


def test_maxsim_by_group():
    s = np.array([[1, 5, 2, 0], [3, 1, 9, 4]], dtype=np.float32)
    g, sc = maxsim_by_group(s, np.array([7, 2, 7, 2]))
    assert list(g) == [2, 7] and list(sc) == [5 + 4, 2 + 9]


# ---------------------------------------------------------------------- store
def test_store_roundtrip_and_delete(store, data):
    ids, docs, _, quant = data
    store.save_quantizer("t", quant)
    assert store.load_quantizer("t") == quant
    assert store.load_quantizer("missing-" + uuid.uuid4().hex) is None

    index, scope = _load(store, data)
    total = sum(len(v) for v in docs)
    sizes = store.partition_sizes(CFG, scope)
    assert sizes.sum() == total
    parts = store.read_partitions(CFG, scope, list(range(CFG.k_ivf)))
    assert [p.centroid for p in parts] == list(range(CFG.k_ivf))
    assert [p.codes.shape[0] for p in parts] == list(sizes)
    assert all(p.counts.sum() == p.codes.shape[0] for p in parts)

    cids, codes = quant.encode(docs[5])
    got = store.read_doc_tokens(CFG, scope, [ids[5], "nope"])
    assert set(got) == {ids[5]}
    np.testing.assert_array_equal(got[ids[5]][0], cids)
    np.testing.assert_array_equal(got[ids[5]][1], codes)

    assert index.delete(scope, ids[5]) is True
    assert index.delete(scope, ids[5]) is False
    assert store.partition_sizes(CFG, scope).sum() == total - len(docs[5])
    assert store.read_doc_tokens(CFG, scope, [ids[5]]) == {}
    assert all(ids[5] not in p.doc_ids
               for p in store.read_partitions(CFG, scope, list(range(CFG.k_ivf))))


def test_replace_does_not_double_count(store, data):
    ids, docs, _, _ = data
    index, scope = _load(store, data)
    before = store.partition_sizes(CFG, scope).copy()
    index.add(scope, ids[0], docs[0])                 # same content again
    np.testing.assert_array_equal(store.partition_sizes(CFG, scope), before)
    index.add(scope, ids[0], docs[1])                 # new content under the same id
    assert store.partition_sizes(CFG, scope).sum() == before.sum() - len(docs[0]) + len(docs[1])


# --------------------------------------------------------------------- search
def test_reading_everything_equals_reference(store, data):
    ids, docs, queries, quant = data
    index, scope = _load(store, data)
    for q in queries[:4]:
        ref = _reference(quant, docs, q)
        want = np.argsort(-ref, kind="stable")[:10]
        for rerank in (0, 50):
            res, st = index.search(scope, q, 10, centroids=list(range(CFG.k_ivf)), rerank=rerank)
            assert [r.doc_id for r in res] == [ids[i] for i in want]
            np.testing.assert_allclose([r.score for r in res], ref[want], atol=1e-3)
            assert st.tokens_scored == sum(len(v) for v in docs)
            assert st.partitions_read == CFG.k_ivf


def test_rerank_returns_full_scores_from_few_partitions(store, data):
    ids, docs, queries, quant = data
    index, scope = _load(store, data)
    q = queries[1]
    ref = dict(zip(ids, _reference(quant, docs, q)))
    res, st = index.search(scope, q, 10, planner="fixed", nprobe=1, rerank=30)
    assert 0 < st.partitions_read <= len(q) and st.reranked <= 30
    assert len(res) == 10
    for r in res:
        assert r.score == pytest.approx(ref[r.doc_id], abs=1e-3)
    assert [r.score for r in res] == sorted((r.score for r in res), reverse=True)


def test_planners_find_the_source_document(store, data):
    ids, _, queries, _ = data
    index, scope = _load(store, data)
    for planner, kw in (("fixed", {"nprobe": 2}), ("mass", {"budget": 8})):
        hits = 0
        for n, q in enumerate(queries):
            res, st = index.search(scope, q, 5, planner=planner, **kw)
            hits += res[0].doc_id == ids[n * 4]
            assert st.partitions_read <= CFG.k_ivf
        assert hits >= len(queries) - 1


def test_buckets_do_not_change_results(data):
    ids, docs, queries, quant = data
    cfg3 = IndexConfig(dim=CFG.dim, k_ivf=CFG.k_ivf, m_pq=CFG.m_pq, n_buckets=3)
    q3 = Quantizer(cfg3, quant.centroids, quant.codebooks)
    a, sa = _load(MemoryStore(), data)
    b, sb = _load(MemoryStore(), data, q3)
    for q in queries[:3]:
        ra, _ = a.search(sa, q, 10, planner="mass", budget=6)
        rb, st = b.search(sb, q, 10, planner="mass", budget=6)
        assert [r.doc_id for r in ra] == [r.doc_id for r in rb]
        assert st.partitions_read == 18


def test_empty_scope_and_empty_doc(store, data):
    _, _, queries, quant = data
    index = Index(store, quant, sizes_ttl_s=0)
    scope = f"empty-{uuid.uuid4().hex[:8]}"
    assert index.search(scope, queries[0], 5)[0] == []
    assert index.add(scope, "x", np.zeros((0, CFG.dim), dtype=np.float32)) == 0
    with pytest.raises(ValueError):
        index.add(scope, "x", np.zeros((3, CFG.dim + 1), dtype=np.float32))


# -------------------------------------------------------------------- planner
def test_fixed_planner():
    s = np.array([[9, 1, 5, 0], [0, 8, 7, 1]], dtype=np.float32)
    assert P.plan_fixed(s, None, nprobe=1) == [0, 1]
    assert set(P.plan_fixed(s, None, nprobe=2)) == {0, 1, 2}
    assert P.plan_fixed(s, np.array([0, 5, 5, 5]), nprobe=1) == [1, 2]     # empty one skipped
    assert P.plan_fixed(s, np.zeros(4, dtype=np.int64), nprobe=2) == []


def test_mass_planner_budget_sharing_and_cost():
    # centroid 2 is second-best for both tokens; 0 and 1 are each best for one token
    s = np.array([[1.00, 0.0, 0.95, 0.0], [0.0, 1.00, 0.95, 0.0]], dtype=np.float32)
    assert P.plan_mass(s, None, budget=1, tau=0.5) == [2]                  # shared wins
    assert len(P.plan_mass(s, None, budget=3, tau=0.5)) == 3
    assert P.plan_mass(s, np.array([5, 5, 0, 5]), budget=1, tau=0.5)[0] in (0, 1)
    assert P.plan_mass(s, np.zeros(4, dtype=np.int64), budget=3) == []
    sizes = np.array([10, 10, 10_000, 10])
    assert P.plan_mass(s, sizes, budget=1, tau=0.5, alpha=1.0)[0] in (0, 1)  # huge one avoided
    # token cap: the first pick is always kept, later ones must fit under the cap
    assert P.plan_mass(s, sizes, budget=4, tau=0.5, alpha=1.0, max_tokens=25) in ([0, 1], [1, 0])
    assert P.plan_mass(s, sizes, budget=4, tau=0.5, max_tokens=25) == [2]
    m = P.partition_mass(s, None, tau=0.5)
    assert m.sum() == pytest.approx(2.0)                                   # one unit per token
    with pytest.raises(ValueError):
        P.plan("nope", s)


# ----------------------------------------------------------------------- eval
def test_exact_search_and_oracle(data):
    ids, docs, queries, quant = data
    exact = ExactCorpus(ids, docs)
    q = queries[2]
    brute = np.array([(q @ v.T).max(axis=1).sum() for v in docs])
    top = exact.search(q, 10)
    assert [d for d, _ in top] == [ids[i] for i in np.argsort(-brute, kind="stable")[:10]]

    tok_c = quant.encode(np.concatenate(docs))[0].astype(np.int64)
    oracle = set(exact.oracle_centroids(q, tok_c, 10))
    ofs = np.r_[0, np.cumsum([len(v) for v in docs])]
    for d, score in top:
        i = ids.index(d)
        keep = np.isin(tok_c[ofs[i]:ofs[i + 1]], list(oracle))
        assert (q @ docs[i][keep].T).max(axis=1).sum() == pytest.approx(score, abs=1e-4)
    assert len(oracle) <= len(q) * 10


def test_metrics():
    assert ndcg_at_k(["a", "b"], {"a": 1}, 10) == 1.0
    assert ndcg_at_k(["b", "a"], {"a": 1}, 10) == pytest.approx(1 / np.log2(3))
    assert ndcg_at_k(["b"], {"a": 1}, 10) == 0.0
    assert overlap_at_k(["a", "x", "c"], ["a", "b", "c"], 3) == pytest.approx(2 / 3)

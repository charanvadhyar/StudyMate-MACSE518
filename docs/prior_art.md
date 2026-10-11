# Prior art: centroid-aligned pooling

Targeted search, 2026-10-10. Question: has anyone already published "merge a document's token
vectors that fall under the same shared (index-level) centroid, so the document keeps one entry
per centroid, stored in a centroid-keyed index"?

Scope and limits: literature and web search (arXiv, ACL Anthology, vendor blogs, GitHub). Patent
databases were NOT searched properly - general web search indexes them poorly. A search on
Google Patents / Espacenet / InPASS by the IPR cell is still needed. Not legal advice.

## Closest findings

| Work | What it does | Overlap with our idea | What it lacks |
|---|---|---|---|
| **ColBERTSaR** - Yang, Yates, Lawrie, Mayfield, Samuel, Jha. SIGIR 2026, arXiv:2606.05568 (4 Jun 2026) | Maps every token to its nearest of 500k-1M k-means anchors; a passage is the **set of distinct anchors** its tokens map to; inverted index keyed by anchor; **no residuals**; score = sum over query tokens of the best query-anchor score among the passage's anchors | **High.** One entry per (passage, centroid) in a centroid-keyed inverted index is exactly this. It is also our `postings="ids"` layout | No vector or code kept per entry; needs a very large codebook (500k-1M); retains about 89-92% of PLAID's nDCG@10 on BEIR; not a database layout |
| **SSR** - Guo et al., ICML 2026, arXiv:2605.30120 | Sparse-autoencoder codes per token; index keeps, per document and neuron, the **maximum activation**; inverted lists keyed by neuron | Medium. One posting per (document, global unit), collapsed with max | Units are SAE neurons, not centroids; stores a scalar, not a vector code |
| **MUVERA** - Dhulipala et al., 2024, arXiv:2405.19504 | Fixed-dimensional encodings: document tokens falling in the same cell of a shared space partition are averaged | Medium. Averaging a document's tokens within a shared partition cell | Random (SimHash) partitions; result is one long single vector, not per-cell index rows |
| **Token pooling** - Clavie, Chaffin, Adams, 2024 (used by ColBERT Live!) | Clusters each document's own tokens (hierarchical / k-means) and mean-pools | Medium. Mean-pooling to store fewer vectors | Clusters are per document, unrelated to the index centroids |
| **PLAID** - Santhanam et al., 2022 | Passage as a "bag of centroid ids" for candidate filtering; residual stored for every token | Medium. Centroid-level view of a passage | Bag is per token (not merged); nothing is pooled |
| **WARP / XTR** - 2025 | Per-cluster residual storage; max-reduction of same-document tokens inside a cluster **at query time** | Low-medium | Stored tokens are not collapsed |
| CRISP (2025), AGC (2026), Learn to Pool (2026), ConstBERT (2025) | Learned or per-document clustering/pooling | Low | All per document |
| Tachiom (Martinico et al., 2026) | Token-aware centroids, PQ residuals per token | Low | No merging |

## What is left that we did not find elsewhere

Each (chunk, centroid) entry carries a **product-quantised residual of the pooled vector**
(mean of the chunk's vectors under that centroid, re-normalised, coded relative to that
centroid), so that

1. a small codebook is enough (2k-4k centroids, trained per corpus in minutes) instead of the
   500k-1M anchors ColBERTSaR needs to work without residuals; our own measurement of the
   residual-free variant at 4,096 centroids: nDCG@10 0.587 against 0.666 with the pooled
   residual codes (SciFact, ColBERTv2);
2. the entry is a row in a wide-column store whose partition key is the centroid and whose
   clustering key is the chunk, so there is exactly one row per chunk per partition; and
3. a second stage rescoring from a per-chunk copy of the same codes.

## Assessment

- The headline form of the idea - one entry per (document, centroid) in a centroid-keyed index -
  **is anticipated by ColBERTSaR**, published four months before this work.
- What remains is an increment: adding a pooled residual code to each such entry, and the
  wide-column layout. An examiner can argue this combines ColBERTSaR (set of anchors) with
  PLAID (residual per token) and token pooling (mean-pool to store fewer vectors).
- The technical argument against obviousness is the small-codebook result in point 1 and the
  measured storage / ingest / fetch effects on Cassandra (see HISTORY.md, entry 13).
- Honest odds of grant: low. A filing is still possible. The same material is a sound basis for
  a short paper or a strong project report.

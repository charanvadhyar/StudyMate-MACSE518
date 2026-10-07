-- smdb index tables. {keyspace} is filled in by CassandraStore.init_schema().
-- Query-driven design: every read below is a single-partition lookup.

CREATE TABLE IF NOT EXISTS {keyspace}.index_meta (
    index_id   text,
    config     text,      -- IndexConfig as JSON
    centroids  blob,      -- float32 [k_ivf, dim]
    codebooks  blob,      -- float32 [m_pq, k_pq, dim / m_pq]
    PRIMARY KEY (index_id)
);

-- The inverted lists. Partition = one centroid's posting list for one scope
-- (and bucket). Row = one chunk; codes = PQ codes of that chunk's tokens that
-- fall in this centroid, m_pq bytes per token.
CREATE TABLE IF NOT EXISTS {keyspace}.postings (
    scope_id     text,
    centroid_id  int,
    bucket       int,
    doc_id       text,
    codes        blob,
    PRIMARY KEY ((scope_id, centroid_id, bucket), doc_id)
);

-- Every token of one chunk, for the rerank stage and for deletes.
CREATE TABLE IF NOT EXISTS {keyspace}.doc_tokens (
    scope_id      text,
    doc_id        text,
    centroid_ids  blob,   -- uint16 little-endian [n_tokens]
    codes         blob,   -- uint8 [n_tokens, m_pq]
    PRIMARY KEY ((scope_id, doc_id))
);

-- Token count per centroid, maintained on write. One partition per scope, so
-- the planner's cost model is a single read.
CREATE TABLE IF NOT EXISTS {keyspace}.partition_stats (
    scope_id     text,
    centroid_id  int,
    n_tokens     counter,
    PRIMARY KEY ((scope_id), centroid_id)
);

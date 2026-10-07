"""Text -> ColBERT token vectors.

ColbertEncoder is ported from colvec/encoder.py. Two marker modes:

  markers="legacy"   colvec behaviour: the literal text "[Q] " / "[D] " is prefixed and
                     tokenized as ordinary word pieces. Reproduces colvec's numbers.
  markers="colbert"  the reference ColBERT convention: the special tokens [unused0]
                     (queries) and [unused1] (documents) are inserted after [CLS].
                     Not yet measured here; A/B it before making it the default.

HashEncoder is a deterministic stand-in with no model download. It is for wiring
tests only and has no retrieval quality.
"""
from __future__ import annotations

import hashlib
import re

import numpy as np

DEFAULT_MODEL = "colbert-ir/colbertv2.0"


class ColbertEncoder:
    def __init__(self, model_name: str = DEFAULT_MODEL, device: str = "cpu",
                 markers: str = "legacy", query_maxlen: int = 32, doc_maxlen: int = 300,
                 augment_queries: bool = False) -> None:
        import torch
        import torch.nn as nn
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file
        from transformers import AutoModel, AutoTokenizer

        if markers not in ("legacy", "colbert"):
            raise ValueError("markers must be 'legacy' or 'colbert'")
        self._torch = torch
        self.device = device
        self.markers = markers
        self.query_maxlen = query_maxlen
        self.doc_maxlen = doc_maxlen
        self.augment_queries = augment_queries
        self.tok = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name).eval().to(device)
        state = load_file(hf_hub_download(repo_id=model_name, filename="model.safetensors"))
        w = state["linear.weight"]
        self.linear = nn.Linear(w.shape[1], w.shape[0], bias=False)
        self.linear.weight.data = w
        self.linear.eval().to(device)
        self.dim = int(w.shape[0])
        self._q_marker = self.tok.convert_tokens_to_ids("[unused0]")
        self._d_marker = self.tok.convert_tokens_to_ids("[unused1]")

    # ------------------------------------------------------------- tokenizing
    def _ids(self, text: str, is_query: bool, maxlen: int) -> list[int]:
        """Token ids including [CLS], marker and [SEP], truncated to maxlen."""
        if self.markers == "legacy":
            prefix = "[Q] " if is_query else "[D] "
            return self.tok(prefix + text, truncation=True, max_length=maxlen)["input_ids"]
        body = self.tok(text, add_special_tokens=False, truncation=True,
                        max_length=maxlen - 3)["input_ids"]
        marker = self._q_marker if is_query else self._d_marker
        return [self.tok.cls_token_id, marker] + body + [self.tok.sep_token_id]

    def _run(self, batch_ids: list[list[int]]) -> list[np.ndarray]:
        """Encode id sequences; returns per-sequence vectors without [CLS] and [SEP]."""
        torch = self._torch
        n = max(len(x) for x in batch_ids)
        ids = torch.full((len(batch_ids), n), self.tok.pad_token_id, dtype=torch.long)
        mask = torch.zeros((len(batch_ids), n), dtype=torch.long)
        for i, x in enumerate(batch_ids):
            ids[i, :len(x)] = torch.tensor(x)
            mask[i, :len(x)] = 1
        with torch.no_grad():
            out = self.model(input_ids=ids.to(self.device),
                             attention_mask=mask.to(self.device)).last_hidden_state
            out = torch.nn.functional.normalize(self.linear(out), dim=2).cpu().numpy()
        return [out[i, 1:len(x) - 1].astype(np.float32) for i, x in enumerate(batch_ids)]

    # ----------------------------------------------------------------- public
    def encode_query(self, text: str) -> np.ndarray:
        ids = self._ids(text, True, self.query_maxlen)
        if self.augment_queries and len(ids) < self.query_maxlen:
            # [MASK] padding acts as learned query expansion; the masks are attended to
            # and their vectors are kept. Helps short queries, neutral on long ones.
            pad = [self.tok.mask_token_id] * (self.query_maxlen - len(ids))
            return self._run_keep(ids + pad, drop={0, len(ids) - 1})   # drop [CLS], [SEP]
        return self._run([ids])[0]

    def _run_keep(self, seq: list[int], drop: set[int]) -> np.ndarray:
        torch = self._torch
        ids = torch.tensor([seq])
        with torch.no_grad():
            out = self.model(input_ids=ids.to(self.device),
                             attention_mask=torch.ones_like(ids).to(self.device)).last_hidden_state[0]
            out = torch.nn.functional.normalize(self.linear(out), dim=1).cpu().numpy()
        keep = [i for i in range(len(seq)) if i not in drop]
        return out[keep].astype(np.float32)

    def encode_doc(self, text: str) -> np.ndarray:
        return self._run([self._ids(text, False, self.doc_maxlen)])[0]

    def encode_docs(self, texts: list[str], batch_size: int = 16) -> list[np.ndarray]:
        out: list[np.ndarray] = []
        for s in range(0, len(texts), batch_size):
            out.extend(self._run([self._ids(t, False, self.doc_maxlen)
                                  for t in texts[s:s + batch_size]]))
        return out


class HashEncoder:
    """Deterministic pseudo-embeddings: one unit vector per word. TEST USE ONLY."""

    def __init__(self, dim: int = 128) -> None:
        self.dim = dim

    def _vec(self, word: str) -> np.ndarray:
        seed = int.from_bytes(hashlib.sha256(word.encode("utf-8")).digest()[:8], "little")
        v = np.random.default_rng(seed).standard_normal(self.dim).astype(np.float32)
        return v / np.linalg.norm(v)

    def _encode(self, text: str, limit: int) -> np.ndarray:
        words = re.findall(r"[a-z0-9]+", text.lower())[:limit]
        if not words:
            return np.zeros((0, self.dim), dtype=np.float32)
        return np.stack([self._vec(w) for w in words])

    def encode_query(self, text: str) -> np.ndarray:
        return self._encode(text, 32)

    def encode_doc(self, text: str) -> np.ndarray:
        return self._encode(text, 300)

    def encode_docs(self, texts: list[str], batch_size: int = 16) -> list[np.ndarray]:
        return [self.encode_doc(t) for t in texts]

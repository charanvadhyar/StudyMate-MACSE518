"""Text -> ColBERT token vectors.

ColbertEncoder loads checkpoints in the Stanford ColBERT format (BERT weights plus a
`linear.weight` projection), e.g. colbert-ir/colbertv2.0 and answerdotai/answerai-colbert-small-v1.

  markers="legacy"   colvec behaviour: the literal text "[Q] " / "[D] " is prefixed and tokenized
                     as ordinary word pieces; [CLS] and [SEP] vectors are dropped. Reproduces
                     colvec's numbers (0.670 nDCG@10 exact on SciFact with colbertv2.0).
  markers="colbert"  the reference ColBERT conventions: [unused0] / [unused1] marker tokens after
                     [CLS]; queries padded to query_maxlen with [MASK] (not attended to, but their
                     vectors are kept); punctuation vectors dropped from documents; [CLS], marker
                     and [SEP] vectors kept. This is what published numbers are measured with.

HashEncoder is a deterministic stand-in with no model download. It is for wiring tests only
and has no retrieval quality.
"""
from __future__ import annotations

import hashlib
import re
import string

import numpy as np

DEFAULT_MODEL = "colbert-ir/colbertv2.0"


def model_tag(model_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", model_name.split("/")[-1].lower()).strip("_")


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
        if "linear.weight" not in state:
            raise ValueError(f"{model_name} has no 'linear.weight'; it is not a Stanford-format "
                             "ColBERT checkpoint and needs a different loader (e.g. PyLate)")
        w = state["linear.weight"]
        self.linear = nn.Linear(w.shape[1], w.shape[0], bias=False)
        self.linear.weight.data = w
        self.linear.eval().to(device)
        self.dim = int(w.shape[0])
        self._q_marker = self.tok.convert_tokens_to_ids("[unused0]")
        self._d_marker = self.tok.convert_tokens_to_ids("[unused1]")
        self._skip = {self.tok.encode(ch, add_special_tokens=False)[0] for ch in string.punctuation}

    # ------------------------------------------------------------- internals
    def _forward(self, ids, mask) -> np.ndarray:
        """ids, mask: LongTensor [b, n] -> unit vectors [b, n, dim] as float32 numpy."""
        torch = self._torch
        with torch.no_grad():
            out = self.model(input_ids=ids.to(self.device),
                             attention_mask=mask.to(self.device)).last_hidden_state
            out = torch.nn.functional.normalize(self.linear(out), dim=2)
        return out.cpu().numpy().astype(np.float32)

    def _body(self, text: str, budget: int) -> list[int]:
        return self.tok(text, add_special_tokens=False, truncation=True,
                        max_length=max(1, budget))["input_ids"]

    def _doc_ids(self, text: str) -> list[int]:
        if self.markers == "legacy":
            return self.tok("[D] " + text, truncation=True, max_length=self.doc_maxlen)["input_ids"]
        return ([self.tok.cls_token_id, self._d_marker] + self._body(text, self.doc_maxlen - 3)
                + [self.tok.sep_token_id])

    # ----------------------------------------------------------------- public
    def encode_query(self, text: str) -> np.ndarray:
        torch = self._torch
        if self.markers == "colbert":
            ids = ([self.tok.cls_token_id, self._q_marker] + self._body(text, self.query_maxlen - 3)
                   + [self.tok.sep_token_id])
            n_real = len(ids)
            ids = ids + [self.tok.mask_token_id] * (self.query_maxlen - n_real)
            mask = [1] * n_real + [0] * (self.query_maxlen - n_real)
            return self._forward(torch.tensor([ids]), torch.tensor([mask]))[0]
        ids = self.tok("[Q] " + text, truncation=True, max_length=self.query_maxlen)["input_ids"]
        n_real = len(ids)
        if self.augment_queries and n_real < self.query_maxlen:
            # colvec's variant: [MASK] padding that IS attended to; drop [CLS] and [SEP], keep masks
            ids = ids + [self.tok.mask_token_id] * (self.query_maxlen - n_real)
            out = self._forward(torch.tensor([ids]), torch.ones((1, len(ids)), dtype=torch.long))[0]
            keep = [i for i in range(len(ids)) if i not in (0, n_real - 1)]
            return out[keep]
        return self._forward(torch.tensor([ids]), torch.ones((1, n_real), dtype=torch.long))[0][1:-1]

    def encode_doc(self, text: str) -> np.ndarray:
        return self.encode_docs([text])[0]

    def encode_docs(self, texts: list[str], batch_size: int = 16) -> list[np.ndarray]:
        torch = self._torch
        result: list[np.ndarray] = []
        for s in range(0, len(texts), batch_size):
            batch = [self._doc_ids(t) for t in texts[s:s + batch_size]]
            n = max(len(x) for x in batch)
            ids = torch.full((len(batch), n), self.tok.pad_token_id, dtype=torch.long)
            mask = torch.zeros((len(batch), n), dtype=torch.long)
            for i, x in enumerate(batch):
                ids[i, :len(x)] = torch.tensor(x)
                mask[i, :len(x)] = 1
            out = self._forward(ids, mask)
            for i, x in enumerate(batch):
                if self.markers == "colbert":
                    keep = [j for j, tid in enumerate(x) if tid not in self._skip]
                    result.append(out[i, keep])
                else:
                    result.append(out[i, 1:len(x) - 1])
        return result


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

# Retrieval sidecar for Railway. Built from a staging folder made by
# scripts/deploy_sidecar.ps1 (smdb/, kernel/, pyproject.toml, this folder, quantizer.npz).

# ---- 1. the Rust scoring kernel (optional: NumPy gives the same results, slower)
FROM rust:1-slim AS kernel
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir "maturin>=1.13,<2.0"
COPY kernel /kernel
WORKDIR /kernel
RUN mkdir -p /wheels && (/venv/bin/maturin build --release --interpreter python3 -o /wheels || echo "kernel build failed; NumPy fallback will be used")

# ---- 2. the service
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 HF_HOME=/app/hf PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
COPY pyproject.toml /app/
COPY smdb /app/smdb
RUN pip install ".[encoder,pdf]"
COPY --from=kernel /wheels /wheels
RUN (ls /wheels/*.whl >/dev/null 2>&1 && pip install /wheels/*.whl) || echo "no kernel wheel"
# bake both models into the image so a restart does not download them again
RUN python -c "from huggingface_hub import snapshot_download as d; d('answerdotai/answerai-colbert-small-v1'); d('sentence-transformers/all-MiniLM-L6-v2')"
COPY deploy/sidecar/start.sh /app/start.sh
COPY quantizer.npz /app/quantizer.npz
RUN sed -i "s/\r$//" /app/start.sh && chmod +x /app/start.sh
ENV SMDB_STORE=cassandra SMDB_MODEL=answerdotai/answerai-colbert-small-v1 SMDB_MARKERS=colbert SMDB_POOL=centroid
CMD ["/app/start.sh"]

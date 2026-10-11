#!/bin/sh
# Wait for Cassandra, store the bundled quantizer once, then serve on Railway's private network.
set -e
HOSTS="${SMDB_CONTACT_POINTS:-127.0.0.1}"
FIRST="$(echo "$HOSTS" | cut -d, -f1)"
echo "[sidecar] waiting for Cassandra at $FIRST:${SMDB_PORT:-9042}"
until python -c "import socket,sys; socket.create_connection(('$FIRST', int('${SMDB_PORT:-9042}')), 3)" 2>/dev/null; do sleep 5; done

ARGS="--hosts $HOSTS --port ${SMDB_PORT:-9042} --keyspace ${SMDB_KEYSPACE:-smdb} --dc ${SMDB_LOCAL_DC:-datacenter1} --rf ${SMDB_RF:-1}"
if python -m smdb.cli $ARGS info | grep -q "no quantizer stored"; then
  echo "[sidecar] storing the bundled quantizer"
  python -m smdb.cli $ARGS load --file /app/quantizer.npz
fi
# "::" listens on IPv6 and IPv4, which Railway's private network uses
exec python -m uvicorn smdb.service:app --host :: --port "${PORT:-8100}"

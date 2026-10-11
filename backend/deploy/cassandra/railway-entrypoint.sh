#!/bin/bash
# Railway wrapper around the official Cassandra entrypoint.
#
# Railway gives each service a stable name (<service>.railway.internal) but not a fixed IP,
# and the name resolves to both IPv4 and IPv6. Cassandra's gossip needs one concrete
# address per node, so on every start we look up this node's IPv4 and the seed's IPv4
# and hand those to the official entrypoint.
#
# Variables (set per Railway service):
#   SEED_HOST          private name of the seed node, e.g. cassandra-1.railway.internal
#   START_DELAY        seconds to wait after the seed is up before joining (stagger nodes 2 and 3)
#   CASSANDRA_CLUSTER_NAME, CASSANDRA_DC, MAX_HEAP_SIZE, HEAP_NEWSIZE  (passed through)
set -euo pipefail

ipv4_of() {
  local name="$1" ip=""
  for _ in $(seq 1 60); do
    ip="$(getent ahostsv4 "$name" 2>/dev/null | awk 'NR==1{print $1}')"
    [ -n "$ip" ] && { echo "$ip"; return 0; }
    sleep 2
  done
  return 1
}

# This container's own private IPv4, read from its network interface. DNS for our own name can
# still point at the previous deployment's container for a while after a redeploy, and binding to
# that address fails with "Cannot assign requested address".
local_ipv4() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10|172|192)\.' | head -1
}

SELF="${RAILWAY_PRIVATE_DOMAIN:-$(hostname)}"
MY_IP="$(local_ipv4)"
[ -n "$MY_IP" ] || MY_IP="$(ipv4_of "$SELF")" || { echo "[node] cannot find own address" >&2; exit 1; }
SEED="${SEED_HOST:-$SELF}"

if [ "$SEED" = "$SELF" ]; then
  SEED_IP="$MY_IP"
  echo "[node] $SELF ($MY_IP) is the seed"
else
  echo "[node] $SELF ($MY_IP) joining seed $SEED; waiting for it to accept clients"
  # resolve again on every try: the seed's address changes when it is redeployed
  while :; do
    SEED_IP="$(ipv4_of "$SEED")" || { echo "[node] cannot resolve seed $SEED" >&2; exit 1; }
    timeout 2 bash -c "</dev/tcp/$SEED_IP/9042" 2>/dev/null && break
    sleep 5
  done
  echo "[node] seed is at $SEED_IP"
  if [ "${START_DELAY:-0}" -gt 0 ]; then
    echo "[node] seed is up; waiting ${START_DELAY}s so nodes join one at a time"
    sleep "$START_DELAY"
  fi
fi

export CASSANDRA_LISTEN_ADDRESS="$MY_IP"
export CASSANDRA_BROADCAST_ADDRESS="$MY_IP"
export CASSANDRA_BROADCAST_RPC_ADDRESS="$MY_IP"
export CASSANDRA_RPC_ADDRESS="0.0.0.0"
export CASSANDRA_SEEDS="$SEED_IP"
export CASSANDRA_ENDPOINT_SNITCH="${CASSANDRA_ENDPOINT_SNITCH:-GossipingPropertyFileSnitch}"
export CASSANDRA_CLUSTER_NAME="${CASSANDRA_CLUSTER_NAME:-StudyMate}"
export CASSANDRA_DC="${CASSANDRA_DC:-datacenter1}"
export MAX_HEAP_SIZE="${MAX_HEAP_SIZE:-1G}"
export HEAP_NEWSIZE="${HEAP_NEWSIZE:-256M}"
# empty cluster: let a node join without waiting for range-movement checks; start faster
export JVM_EXTRA_OPTS="${JVM_EXTRA_OPTS:-} -Dcassandra.consistent.rangemovement=false -Dcassandra.skip_wait_for_gossip_to_settle=0"

exec /usr/local/bin/docker-entrypoint.sh "$@"

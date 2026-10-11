"""Measure what a table really occupies on disk inside a Cassandra Docker container."""
from __future__ import annotations

import subprocess


def disk_bytes(container: str, keyspace: str, table: str, compact: bool = True) -> int | None:
    """On-disk size of one table (data + index files) inside a Cassandra container.

    The table is flushed and, with compact=True, major-compacted first, so that the number is
    the settled size rather than a pile of not-yet-merged segments. Snapshot folders (left
    behind by DROP TABLE / TRUNCATE) are not counted.
    """
    def nodetool(*a, timeout=3600):
        subprocess.run(["docker", "exec", container, "nodetool", *a],
                       check=True, capture_output=True, timeout=timeout)
    try:
        nodetool("flush", keyspace, table)
        if compact:
            print(f"compacting {keyspace}.{table} before measuring (can take minutes) ...", flush=True)
            nodetool("compact", keyspace, table)
        out = subprocess.run(
            ["docker", "exec", container, "sh", "-c",
             f"du -sb --exclude=snapshots --exclude=backups "
             f"/var/lib/cassandra/data/{keyspace}/{table}-* | cut -f1"],
            check=True, capture_output=True, text=True, timeout=120).stdout.split()
        return sum(int(x) for x in out) if out else None
    except Exception as e:  # docker missing, container name different, ...
        print(f"could not measure disk size ({type(e).__name__}); run it by hand: "
              f"docker exec {container} du -sh /var/lib/cassandra/data/{keyspace}")
        return None

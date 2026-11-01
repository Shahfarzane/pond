#!/bin/bash
# Usage: wait-log.sh <log> <extended-regex> <count> <timeout-seconds>
# Waits until the regex matches at least <count> lines, then prints the pipeline lines.
log="$1"; pattern="$2"; want="$3"; timeout="$4"
end=$((SECONDS + timeout))
while [ $SECONDS -lt "$end" ]; do
  n=$(grep -c -E "$pattern" "$log" 2>/dev/null || true)
  [ "${n:-0}" -ge "$want" ] && break
  sleep 2
done
grep -E 'task web/|archive-page\] (crawl|page|nav|harvest|auth|retry)|bot check|\[pond scrape\]' "$log" | cut -c1-260

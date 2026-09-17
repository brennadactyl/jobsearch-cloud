#!/usr/bin/env bash
# Usage: tools/tracker-rig/run.sh <old tracker.ps1> <new tracker.ps1> [port]
#
# Runs every line of scenarios.txt (name|scenario|arguments) through both
# versions of tracker.ps1, each in a fresh folder with the fixtures copied in,
# launched the way run-search.ps1's ./tracker wrapper launches it, against
# stub.mjs. Then diffs what each version printed, its exit code, the files it
# wrote, and every request it sent. A refactor passes only with both diffs
# empty. Needs Windows PowerShell and node; run from Git Bash.
set -u
RIG=$(cd "$(dirname "$0")" && pwd)
OLD=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
NEW=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
PORT=${3:-8791}
OUT=$(mktemp -d)
node "$RIG/stub.mjs" "$PORT" "$OUT/requests.log" & STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
sleep 1
for v in old new; do
  src=$OLD; [ $v = new ] && src=$NEW
  mkdir -p "$OUT/$v/out" "$OUT/$v/work/known"
  while IFS='|' read -r name scen cmd; do
    [ -z "$name" ] && continue
    if [[ $name == known* ]]; then d=$OUT/$v/work/known; else d=$OUT/$v/work/$name; mkdir -p "$d"; fi
    cp "$RIG"/fixtures/* "$d"/; cp "$src" "$d/tracker.ps1"
    ( cd "$d"
      if [ "$name" = noenv ]; then unset TRACKER_URL TRACKER_API_TOKEN
      else export TRACKER_URL="http://127.0.0.1:$PORT/$v/$scen/" TRACKER_API_TOKEN=tok; fi
      export TRACKER_SEARCH=SWE
      eval "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tracker.ps1 $cmd" > "$OUT/$v/out/$name.txt" 2>&1
      echo "exit=$?" >> "$OUT/$v/out/$name.txt"
      for f in *.json; do [ -f "$RIG/fixtures/$f" ] || { echo "--- file $f"; cat "$f"; }; done >> "$OUT/$v/out/$name.txt"
    )
  done < "$RIG/scenarios.txt"
done
status=0
diff -r "$OUT/old/out" "$OUT/new/out" && echo "output: identical" || status=1
diff <(grep '^old ' "$OUT/requests.log" | cut -d' ' -f2-) <(grep '^new ' "$OUT/requests.log" | cut -d' ' -f2-) && echo "requests: identical ($(grep -c '^new ' "$OUT/requests.log") per version)" || status=1
echo "results in $OUT"
exit $status

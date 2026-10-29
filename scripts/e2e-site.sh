#!/usr/bin/env bash
# Headless Chrome on the LIVE site: the terminal boots to a bash prompt and
# Chrome logs no CSP violation or JavaScript error.
#   usage: scripts/e2e-site.sh <page URL>
set -euo pipefail
URL=$1
CHROME=${CHROME:-google-chrome}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
"$CHROME" ${CHROME_FLAGS:-} --version
timeout 120 "$CHROME" ${CHROME_FLAGS:-} --headless=new --disable-gpu --no-first-run --enable-logging=stderr --v=0 \
  --virtual-time-budget=15000 --window-size=1100,700 --dump-dom "$URL" >"$tmp/dom.html" 2>"$tmp/console.log"
python3 - "$tmp/dom.html" "$tmp/console.log" <<'PY'
import re, sys
dom = open(sys.argv[1], encoding="utf-8").read()
log = open(sys.argv[2], encoding="utf-8", errors="replace").read()
text = re.sub(r"<[^>]+>", "", dom).replace("&nbsp;", " ")
prompt = "user@badita:~$" in text
motd = "Welcome to Ubuntu" in text
bad = [l for l in log.splitlines() if "Content Security Policy" in l or "Refused to" in l or "Uncaught" in l]
print(f"prompt: {prompt}, motd: {motd}, console problems: {bad or 'none'}")
sys.exit(0 if prompt and motd and not bad else 1)
PY

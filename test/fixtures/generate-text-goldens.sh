#!/usr/bin/env bash
# Regenerate test/fixtures/text-goldens.json from the real Python ScaleDP Box
# implementation, so the TS port is verified against actual behaviour rather
# than against itself. Requires a ScaleDP virtualenv with opencv installed.
set -euo pipefail
cd "$(dirname "$0")"
PYTHON="${SCALEDP_PYTHON:-$HOME/Library/Caches/pypoetry/virtualenvs/scaledp-DbEJkcaR-py3.12/bin/python}"
"$PYTHON" generate-text-goldens.py > text-goldens.json
echo "wrote text-goldens.json ($(grep -c '"fn"' text-goldens.json) cases)"

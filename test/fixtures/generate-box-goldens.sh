#!/usr/bin/env bash
# Regenerate test/fixtures/box-goldens.json from the real Python ScaleDP Box
# implementation, so the TS port is verified against actual behaviour rather
# than against itself. Requires a ScaleDP virtualenv with opencv installed.
set -euo pipefail
cd "$(dirname "$0")"
PYTHON="${SCALEDP_PYTHON:-$HOME/Library/Caches/pypoetry/virtualenvs/scaledp-DbEJkcaR-py3.12/bin/python}"
"$PYTHON" generate-box-goldens.py > box-goldens.json
echo "wrote box-goldens.json ($(grep -c '"fn"' box-goldens.json) cases)"

#!/bin/sh
# macOS: double-click to open Cortex Council in your browser. Close this window to stop it.
exec node "$(dirname "$0")/../bin/cortex-council.mjs" "$@"

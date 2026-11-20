#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

status=0
bun scripts/check-names.ts --tool-call || status=$?
case "$status" in
  0) exit 0 ;;
  1) exit 2 ;;
esac
echo "names check hook: check:names --tool-call exited $status (cause above), so the names this tool call creates went unchecked and the call is stopped. Repair: fix the cause above, or run bun run check:names <path> for each path it creates. Done when that command passes." >&2
exit 2

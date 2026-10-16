#!/bin/sh
set -eu

case "${CMD}" in
  api) exec node dist/bin/api.js ;;
  relay) exec node dist/bin/relay.js ;;
  worker) exec node dist/bin/worker.js ;;
  *) echo "unsupported CMD: ${CMD}" >&2; exit 1 ;;
esac

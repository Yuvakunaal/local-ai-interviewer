#!/usr/bin/env bash
# Verifies prerequisites. Exit code 0 = ready to run, 1 = something blocking is missing.
# Never installs or downloads anything.
exec "$(cd "$(dirname "$0")" && pwd)/scripts/run.sh" check "$@"

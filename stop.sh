#!/usr/bin/env bash
# Stops the app. Ollama is stopped only if start.sh/setup-models.sh started it (never the Ollama app you opened yourself).
# Never deletes models or data. Use --unload to also free the model's RAM in a running Ollama.
exec "$(cd "$(dirname "$0")" && pwd)/scripts/run.sh" stop "$@"

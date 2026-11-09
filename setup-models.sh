#!/usr/bin/env bash
# Installs ONLY the models this app needs, after showing sizes and asking for confirmation.
#   ./setup-models.sh            interview LLM (+ the Phonon voice on Apple Silicon Macs)
#   ./setup-models.sh --stt      also the optional offline Whisper model for microphone answers
#   ./setup-models.sh --yes      skip the confirmation prompt
# Needs internet once, to download. Afterwards everything works offline.
exec "$(cd "$(dirname "$0")" && pwd)/scripts/run.sh" setup-models "$@"

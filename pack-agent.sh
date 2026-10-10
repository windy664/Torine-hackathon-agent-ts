#!/bin/sh
# Package the TypeScript agent for the ARC-Bench competition submission panel.
# Usage: sh pack-agent.sh [output.zip]
set -eu

AGENT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -eq 0 ]; then
  PACKAGE_DIR=$(mktemp -d /tmp/torine-agent.XXXXXX)
  ARCHIVE_PATH="$PACKAGE_DIR/torine-evolution-agent.zip"
else
  ARCHIVE_PATH=$1
fi

case "$ARCHIVE_PATH" in
  /*) ;;
  *) ARCHIVE_PATH="$(pwd)/$ARCHIVE_PATH" ;;
esac

mkdir -p "$(dirname -- "$ARCHIVE_PATH")"
if [ -e "$ARCHIVE_PATH" ]; then
  echo "[pack-agent] output already exists: $ARCHIVE_PATH" >&2
  exit 1
fi

(cd "$AGENT_ROOT" && zip -r -q "$ARCHIVE_PATH" \
  index.ts judge.ts judge-plan.ts judge-runner.ts controller-*.ts package.json package-lock.json tsconfig.json \
  arcbench-agent-runtime-js skills template sheet-scaffold \
  -x '*/node_modules/*' '*/dist/*' '*/.git/*' '*.db' '*.sqlite' '*.log' '*.zip' '.env*')

unzip -tq "$ARCHIVE_PATH" >/dev/null
echo "[pack-agent] $ARCHIVE_PATH"

#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v node >/dev/null 2>&1 && [ -f "$task_root/manage.mjs" ]; then
  exec node "$task_root/manage.mjs" uninstall "$@"
fi
for host in \
  "/Applications/Antigravity.app/Contents/MacOS/Antigravity" \
  "/usr/lib/antigravity/antigravity" \
  "/usr/share/antigravity/antigravity" \
  "$HOME/.local/share/antigravity/antigravity"
do
  if [ -x "$host" ] && [ -f "$task_root/manage.mjs" ]; then
    export ELECTRON_RUN_AS_NODE=1
    exec "$host" "$task_root/manage.mjs" uninstall "$@"
  fi
done
exec python3 "$task_root/manage.py" uninstall "$@"

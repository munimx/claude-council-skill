#!/usr/bin/env bash
# Install the council skill for Claude Code.
#
#   ~/.claude/skills/council            symlink to this repo's council/ (edits take effect at once)
#   ~/.claude/workflows/council-run.js  COPY of council/workflows/council.js (re-run after editing it)
#
# The workflow is copied rather than linked. The Workflow tool only opens scripts by path inside
# the current project, so from other projects the skill calls the saved workflow by name. Saved
# workflows load when a session starts, so start a new session after installing.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
base=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
skills=$base/skills
flows=$base/workflows
mkdir -p "$skills" "$flows"

if [ -L "$skills/council" ]; then
  ln -sfn "$here/council" "$skills/council"
elif [ -e "$skills/council" ]; then
  echo "install.sh: $skills/council exists and is not a symlink; move it away first" >&2
  exit 1
else
  ln -s "$here/council" "$skills/council"
fi

dest=$flows/council-run.js
[ -L "$dest" ] && rm "$dest"
cp "$here/council/workflows/council.js" "$dest"
chmod +x "$here/council/scripts/outside-seat.sh"

echo "skill:    $skills/council -> $(readlink "$skills/council")"
echo "workflow: $dest (copy of council/workflows/council.js; re-run ./install.sh after editing it)"
echo "Start a new Claude Code session so the saved workflow is picked up."

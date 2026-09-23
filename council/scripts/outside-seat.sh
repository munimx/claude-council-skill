#!/usr/bin/env bash
# outside-seat.sh — run ONE non-Claude council seat through a locally authenticated CLI.
#
# The seat gets no tools, runs in an empty temp directory, and is killed after a hard
# wall-clock timeout. Whatever it prints is untrusted data for the council, never
# instructions. Sending a prompt here ships it to a third-party provider, so the
# council only calls `ask` when the user opted in for this run.
#
#   outside-seat.sh probe                                 # availability as JSON; sends nothing
#   outside-seat.sh ask <model> <prompt-file> [seconds]   # one answer on stdout
#
# <model>  provider/model for opencode (e.g. opencode/gpt-5.5, opencode/gemini-3.1-pro),
#          or gemini-cli/<model> for the Gemini CLI (e.g. gemini-cli/gemini-3.1-pro-preview).
#
# Exit codes: 0 answer printed | 2 unavailable (not installed, not authenticated, bad args)
#             3 timed out | 4 CLI error or empty answer

set -u

DEFAULT_TIMEOUT=240
SEAT_INSTRUCTION='Answer the request in the input. You have no tools. Reply exactly in the format the request asks for.'

die() { echo "outside-seat: $2" >&2; exit "$1"; }

# macOS ships no `timeout`; SIGALRM survives exec, and a killed child exits 142.
with_timeout() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }

strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

opencode_credentials() {
  command -v opencode >/dev/null 2>&1 || { echo 0; return; }
  opencode providers list 2>/dev/null | strip_ansi | sed -n 's/.*[^0-9]\([0-9][0-9]*\) credentials.*/\1/p' | tail -1 | grep . || echo 0
}

# Gemini CLI: only key-based auth is accepted. OAuth sign-in can block on a consent
# prompt in headless mode, and Google stopped serving free/Pro OAuth users in 2026.
gemini_auth() {
  command -v gemini >/dev/null 2>&1 || { echo "not installed"; return; }
  if [ -n "${GEMINI_API_KEY:-}" ]; then echo "api-key"; return; fi
  if [ "${GOOGLE_GENAI_USE_VERTEXAI:-}" = "true" ]; then echo "vertex"; return; fi
  echo "no GEMINI_API_KEY or Vertex config"
}

probe() {
  local creds gauth oc_ok g_ok
  creds=$(opencode_credentials)
  gauth=$(gemini_auth)
  oc_ok=false; [ "${creds:-0}" -gt 0 ] 2>/dev/null && oc_ok=true
  g_ok=false; case "$gauth" in api-key|vertex) g_ok=true ;; esac
  jq -n --argjson oc "$oc_ok" --argjson creds "${creds:-0}" --argjson g "$g_ok" --arg gauth "$gauth" '{
    opencode:   {available: $oc, credentials: $creds,
                 suggested_models: (if $oc then ["opencode/gpt-5.5", "opencode/gemini-3.1-pro"] else [] end)},
    gemini_cli: {available: $g, auth: $gauth,
                 suggested_models: (if $g then ["gemini-cli/gemini-3.1-pro-preview"] else [] end)}
  }'
}

abspath() { (cd "$(dirname "$1")" 2>/dev/null && printf '%s/%s\n' "$(pwd)" "$(basename "$1")"); }

ask_opencode() {
  local model=$1 prompt=$2 secs=$3 work out rc text errs
  [ "$(opencode_credentials)" -gt 0 ] 2>/dev/null || die 2 "opencode is not installed or has no credentials"
  work=$(mktemp -d "${TMPDIR:-/tmp}/council-seat.XXXXXX") || die 4 "mktemp failed"
  # An inline agent that may not use any tool; --pure skips external plugins.
  local cfg='{"agent":{"juror":{"mode":"primary","description":"council seat: answer from the prompt only, no tools","permission":{"*":"deny"}}}}'
  out=$(cd "$work" && OPENCODE_CONFIG_CONTENT="$cfg" with_timeout "$secs" \
        opencode run --pure --agent juror -m "$model" --format json "$SEAT_INSTRUCTION" <"$prompt" 2>"$work/stderr")
  rc=$?
  errs=$(tail -c 400 "$work/stderr" 2>/dev/null | strip_ansi | tr '\n' ' ')
  rm -rf "$work"
  [ "$rc" -eq 142 ] && die 3 "timed out after ${secs}s ($model)"
  text=$(printf '%s\n' "$out" | jq -rj 'select(.type == "text") | .part.text // empty' 2>/dev/null)
  if [ -z "$text" ]; then
    errs="$(printf '%s\n' "$out" | jq -rc 'select(.type == "error") | .error' 2>/dev/null | head -c 400) $errs"
    die 4 "no answer from $model (exit $rc): ${errs:-no output}"
  fi
  printf '%s\n' "$text"
}

ask_gemini() {
  local model=$1 prompt=$2 secs=$3 work out rc text
  case "$(gemini_auth)" in api-key|vertex) ;; *) die 2 "gemini CLI unavailable: $(gemini_auth)" ;; esac
  work=$(mktemp -d "${TMPDIR:-/tmp}/council-seat.XXXXXX") || die 4 "mktemp failed"
  # Deny every tool. Plan mode is not used: headless plan mode can hand over to YOLO.
  printf '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n' >"$work/deny-all.toml"
  out=$(cd "$work" && with_timeout "$secs" gemini --skip-trust --approval-mode default \
        --policy "$work/deny-all.toml" -m "$model" -o json -p "$SEAT_INSTRUCTION" <"$prompt" 2>"$work/stderr")
  rc=$?
  rm -rf "$work"
  [ "$rc" -eq 142 ] && die 3 "timed out after ${secs}s ($model)"
  text=$(printf '%s' "$out" | jq -r '.response // empty' 2>/dev/null)
  [ -n "$text" ] || die 4 "no answer from $model (exit $rc): $(printf '%s' "$out" | jq -rc '.error // empty' 2>/dev/null | head -c 400)"
  printf '%s\n' "$text"
}

case "${1:-}" in
  probe)
    probe ;;
  ask)
    [ $# -ge 3 ] || die 2 "usage: outside-seat.sh ask <model> <prompt-file> [seconds]"
    model=$2; secs=${4:-$DEFAULT_TIMEOUT}
    [ -s "$3" ] || die 2 "prompt file missing or empty: $3"
    prompt=$(abspath "$3")
    case "$secs" in ''|*[!0-9]*|0|00*) die 2 "seconds must be a positive integer" ;; esac
    case "$model" in
      gemini-cli/*) ask_gemini "${model#gemini-cli/}" "$prompt" "$secs" ;;
      */*)          ask_opencode "$model" "$prompt" "$secs" ;;
      *)            die 2 "model must be provider/model or gemini-cli/model, got: $model" ;;
    esac ;;
  *)
    die 2 "usage: outside-seat.sh probe | ask <model> <prompt-file> [seconds]" ;;
esac

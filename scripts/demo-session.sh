#!/usr/bin/env bash
# Terminal session recorded for docs/media/demo.gif. Makes no model calls and needs no API key.
# Record: asciinema rec -c "bash scripts/demo-session.sh" --cols 112 --rows 27 demo.cast
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.node22/bin:$PATH"
unset NO_COLOR FORCE_COLOR
printf '\e[?25l'; trap "printf '\e[?25h'" EXIT

B=$'\e[1m'; D=$'\e[2m'; C=$'\e[1;36m'; M=$'\e[1;35m'; R=$'\e[0m'

center() { # text, width
  local pad=$(( (112 - ${#1}) / 2 )); printf '%*s%s\n' "$pad" '' "$1"
}
card() { # title, subtitle, seconds
  clear; printf '\n%.0s' {1..10}
  printf '%s' "$B"; center "$1"; printf '%s\n' "$R"
  printf '%s' "$D"; center "$2"; printf '%s' "$R"
  sleep "$3"
}
caption() { # text, seconds
  clear; printf '\n %s%s%s\n %s\n\n' "$M" "$1" "$R" "$D$(printf '%.0s-' {1..108})$R"; sleep "$2"
}
type_cmd() { # command shown and then run
  printf '%s$%s ' "$C" "$R"
  local i; for (( i=0; i<${#1}; i++ )); do printf '%s' "${1:i:1}"; sleep 0.02; done
  printf '\n'; sleep 0.4
  bash -c "$1"
}

card "CodeGovernor: Agentic Coding Control Plane" \
  "Hard boundaries, budgets and audit logs for coding agents" 5

caption "1/4  Offline unit tests: scripted fake agents, real hook scripts, no API calls" 2.5
type_cmd "npm test 2>&1 | grep -E 'Test Files|Tests '"
sleep 5

caption "2/4  Fail-closed shell hook denies the command a coder ran in recorded run 1" 2.5
type_cmd "cd examples/target && echo '{\"command\":\"pip3 install pytest --break-system-packages\"}' \\
  | python3 .cursor/hooks/shell_policy.py | python3 -m json.tool"
sleep 7

caption "3/4  Replay of recorded run 2 through the real pipeline and gate (no model calls)" 2.5
type_cmd "npm run -s demo:replay -- --pause-ms 2200"
sleep 8

caption "4/4  Same recording, logged paths fed to the current coder path check" 2.5
type_cmd "npm run -s demo:replay -- --check-paths --speed 0 --pause-ms 0 | tail -10"
sleep 9

card "github.com/nishanttyagi28/codegovernor" "Replayed from committed logs in runs/. No model calls were made." 4

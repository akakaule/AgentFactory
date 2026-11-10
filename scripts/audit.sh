#!/usr/bin/env bash
# Run one audit (docs/spec/2026-11-10-audit-loop-design.md) against a workspace's repository and
# file its findings on the board as backlog tasks.
#
#   scripts/audit.sh <workspace> <area> <lens> [--repo <path>] [--profile <path>] [--dry-run]
#   scripts/audit.sh nimbus resolver bugs --repo ~/src/NimBus --dry-run
#
# Environment:
#   AGENTFACTORY_MCP_CONFIG  MCP config whose "agentfactory" server is pinned to the workspace
#                            (default ~/.config/agentfactory/mcp-<workspace>.json)
#   AUDIT_LOG_DIR            where the JSON result goes (default ~/.config/agentfactory/logs)
#   AUDIT_MODEL, AUDIT_EFFORT, AUDIT_MAX_TURNS   default claude-fable-5-2, high, 200
#   AUDIT_BASH_ALLOW         comma-separated Bash permission patterns for the profile's build and
#                            test commands (default: dotnet build/test and npm test/run)
set -euo pipefail

usage() { echo "usage: scripts/audit.sh <workspace> <area> <lens> [--repo <path>] [--profile <path>] [--dry-run]" >&2; exit 2; }

positional=() repo="" profile="" dry=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) [[ $# -ge 2 ]] || usage; repo="$2"; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || usage; profile="$2"; shift 2 ;;
    --dry-run) dry="--dry-run"; shift ;;
    -*) usage ;;
    *) positional+=("$1"); shift ;;
  esac
done
[[ ${#positional[@]} -eq 3 ]] || usage
workspace="${positional[0]}" area="${positional[1]}" lens="${positional[2]}"

af_root="$(cd "$(dirname "$0")/.." && pwd)"
command_file="$af_root/.claude/commands/audit.md"
repo="$(cd "${repo:-.}" && git rev-parse --show-toplevel)"

if [[ -z "$profile" ]]; then
  for candidate in "$repo/.agents/audit-profile.md" "$HOME/.config/agentfactory/audit/$workspace.md"; do
    if [[ -f "$candidate" ]]; then profile="$candidate"; break; fi
  done
fi
[[ -n "$profile" && -f "$profile" ]] || { echo "no audit profile for '$workspace' (see docs/audit-profile.md)" >&2; exit 1; }
profile="$(cd "$(dirname "$profile")" && pwd)/$(basename "$profile")"

mcp="${AGENTFACTORY_MCP_CONFIG:-$HOME/.config/agentfactory/mcp-$workspace.json}"
[[ -f "$mcp" ]] || { echo "MCP config not found: $mcp" >&2; exit 1; }
logs="${AUDIT_LOG_DIR:-$HOME/.config/agentfactory/logs}"
mkdir -p "$logs"

cd "$repo"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "warning: $repo has uncommitted changes; findings will reflect them" >&2
fi

# Feed the command body to claude -p, so the audited repository needs no copy of the command.
placeholder='$ARGUMENTS'
args="$profile $workspace $area $lens${dry:+ $dry}"
body="$(awk 'NR == 1 && /^---$/ { fm = 1; next } fm && /^---$/ { fm = 0; next } !fm' "$command_file")"
prompt="${body//"$placeholder"/"$args"}"

allowed=(Read Grep Glob Agent
  "Bash(git log:*)" "Bash(git show:*)" "Bash(git blame:*)" "Bash(git rev-parse:*)"
  mcp__agentfactory__list_tasks mcp__agentfactory__get_task mcp__agentfactory__create_task)
IFS=',' read -r -a bash_allow <<< "${AUDIT_BASH_ALLOW:-dotnet build:*,dotnet test:*,npm test:*,npm run:*}"
for pattern in "${bash_allow[@]}"; do allowed+=("Bash($pattern)"); done

extra_dirs=()
[[ "$profile" == "$repo"/* ]] || extra_dirs=(--add-dir "$(dirname "$profile")")

log="$logs/audit-$(date +%F-%H%M)-$workspace-$area-$lens.json"
claude -p "$prompt" \
  --model "${AUDIT_MODEL:-claude-fable-5-2}" --effort "${AUDIT_EFFORT:-high}" \
  --max-turns "${AUDIT_MAX_TURNS:-200}" \
  --mcp-config "$mcp" "${extra_dirs[@]}" \
  --allowedTools "${allowed[@]}" \
  --output-format json > "$log"

node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.result??r);console.error(`\ncost $${(r.total_cost_usd??0).toFixed(2)}, log ${process.argv[1]}`)' "$log"

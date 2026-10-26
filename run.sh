#!/usr/bin/env bash
# ============================================================
#  SIMRS-Flow runner (Linux / macOS) - same commands as run.bat
#  Run without arguments for a menu, or:  ./run.sh <command>
#  Commands: install dev ui api typecheck lint test test:watch
#            livetest build start clean free-port
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# Load KEY=VALUE pairs from .env; variables already in the shell win.
if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    key="${line%%=*}"; value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value%$'\r'}"; value="${value#\"}"; value="${value%\"}"
    [[ -z "${!key:-}" ]] && export "$key=$value"
  done < .env
fi
export ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-4500}"
UI_PORT=5173

lan_urls() {
  # Addresses other PCs on the LAN can open (empty when offline).
  local port="$1" ip
  for ip in $(hostname -I 2>/dev/null || true); do
    [[ "$ip" == *:* ]] && continue
    echo "    http://$ip:$port/"
  done
}

ensure_deps() {
  if [[ ! -d node_modules ]]; then
    echo "[setup] node_modules missing - running npm install first..."
    npm install
  fi
}

port_pids() {
  if command -v lsof >/dev/null 2>&1; then lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then fuser "$1"/tcp 2>/dev/null || true
  fi
}

clear_port() {
  local port="$1" name="$2" pids
  pids="$(port_pids "$port")"
  [[ -z "$pids" ]] && return 0
  echo "[port] $name port $port is used by PID(s): $pids"
  ps -o pid=,cmd= -p $pids 2>/dev/null | sed 's/^/  /' || true
  read -r -p "Stop them? [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "[port] Nothing stopped."; return 1; }
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(port_pids "$port")"
  [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
  echo "[port] Port $port is free."
}

clean_emitted() {
  # tsc output emitted next to source (gitignored, but it shadows .ts under vitest/tsx).
  find packages apps -path '*/node_modules' -prune -o -path '*/src/*' -type f \
    \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) \
    ! -name '*.test.*' -print -delete >/dev/null
  find . -path ./node_modules -prune -o -name tsconfig.tsbuildinfo -type f -print -delete >/dev/null
}

do_dev() {
  clear_port "$ORCHESTRATOR_PORT" orchestrator
  clear_port "$UI_PORT" UI
  echo "[dev] orchestrator + UI (Ctrl+C stops both)"
  npm run dev:orchestrator & api=$!
  npm run dev:ui & ui=$!
  trap 'kill $api $ui 2>/dev/null; wait 2>/dev/null; exit 0' INT TERM
  echo
  echo "  UI (this PC): http://localhost:$UI_PORT/"
  lan_urls "$UI_PORT"
  wait
}

do_build() {
  echo "[build] building all workspaces (UI bundle into apps/ui/dist)..."
  npm run build
  echo "[build] cleaning compiled .js/.d.ts emitted next to source..."
  clean_emitted
  echo "[build] done. './run.sh start' serves API + UI on port $ORCHESTRATOR_PORT."
}

do_start() {
  if [[ ! -f apps/ui/dist/index.html ]]; then
    echo "[start] apps/ui/dist is missing - building first..."
    do_build
  fi
  clear_port "$ORCHESTRATOR_PORT" orchestrator
  [[ -z "${AUDIT_LEDGER_DIR:-}" ]] && echo "[start] WARNING: AUDIT_LEDGER_DIR is not set - run history is lost on restart."
  echo "[start] orchestrator (production): API + UI on one port"
  echo "  this PC: http://localhost:$ORCHESTRATOR_PORT/"
  [[ "${ORCHESTRATOR_HOST:-0.0.0.0}" == "127.0.0.1" ]] || lan_urls "$ORCHESTRATOR_PORT"
  exec npm run start --workspace @simrs-flow/orchestrator
}

dispatch() {
  local cmd="$1"
  [[ "$cmd" == install ]] || ensure_deps
  case "$cmd" in
    install)    npm install ;;
    dev)        do_dev ;;
    ui)         clear_port "$UI_PORT" UI && npm run dev:ui ;;
    api)        clear_port "$ORCHESTRATOR_PORT" orchestrator && npm run dev:orchestrator ;;
    typecheck)  npm run typecheck ;;
    lint)       npm run lint ;;
    test)       npm test ;;
    test:watch) npm run test:watch ;;
    livetest)   bash scripts/livetest.sh ;;
    build)      do_build ;;
    start)      do_start ;;
    clean)      clean_emitted; rm -rf apps/ui/dist; echo "[clean] done." ;;
    free-port)  clear_port "$ORCHESTRATOR_PORT" orchestrator || true; clear_port "$UI_PORT" UI || true ;;
    *) echo "Unknown command: $cmd"
       echo "Usage: ./run.sh [install|dev|ui|api|typecheck|lint|test|test:watch|livetest|build|start|clean|free-port]"
       exit 1 ;;
  esac
}

if [[ $# -gt 0 ]]; then dispatch "$1"; exit; fi

cat <<MENU
============================================================
  SIMRS-Flow
============================================================
  DEVELOP (from TypeScript source, no build needed)
    [1]  Install dependencies (npm install)
    [2]  Dev: orchestrator + UI
    [3]  Dev: UI only           (port $UI_PORT)
    [4]  Dev: orchestrator only (port $ORCHESTRATOR_PORT)
  VERIFY
    [5]  Typecheck   [6] Lint   [7] Test   [8] Test (watch)
    [9]  Live smoke test (scripts/livetest.sh)
  PRODUCTION
    [10] Build (UI bundle -> apps/ui/dist)
    [11] Start (API + UI on port $ORCHESTRATOR_PORT, LAN)
    [12] Clean emitted output + UI dist
  TROUBLESHOOT
    [13] Free ports ($ORCHESTRATOR_PORT, $UI_PORT)
    [0]  Exit
MENU
read -r -p "Choose: " pick
case "$pick" in
  1) dispatch install ;;  2) dispatch dev ;;      3) dispatch ui ;;     4) dispatch api ;;
  5) dispatch typecheck ;; 6) dispatch lint ;;    7) dispatch test ;;   8) dispatch test:watch ;;
  9) dispatch livetest ;; 10) dispatch build ;;  11) dispatch start ;; 12) dispatch clean ;;
  13) dispatch free-port ;; 0|'') exit 0 ;;
  *) echo "Invalid choice."; exit 1 ;;
esac

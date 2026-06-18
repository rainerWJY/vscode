#!/usr/bin/env bash
#
# start-frontend.sh -- Start the Sessions Window (frontend) and connect
#                     to the agent host backend via WebSocket.
#
# Usage:
#   ./start-frontend.sh
#
# Prerequisites: start-backend.sh must be running first.
#
# Environment variables:
#   VSCODE_SESSIONS_PORT    Frontend port (default: 8081)
#   VSCODE_AGENT_HOST_PORT  Backend port  (default: 8082)
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# -- 1. Ensure backend is reachable ------------------------------------------
BACKEND_PORT="${VSCODE_AGENT_HOST_PORT:-8082}"
echo ">> Checking agent host backend on ws://localhost:${BACKEND_PORT} ..."
if ! curl -s -o /dev/null --connect-timeout 3 "http://localhost:${BACKEND_PORT}" 2>/dev/null; then
	echo "!! Warning: Backend does not seem to be running on port ${BACKEND_PORT}."
	echo "    Start it first in another terminal:"
	echo "        ./start-backend.sh"
	echo "    Or skip this check by setting VSCODE_SKIP_BACKEND_CHECK=1"
	echo ""
	if [ -z "${VSCODE_SKIP_BACKEND_CHECK:-}" ]; then
		exit 1
	fi
else
	echo ">> Backend is reachable."
fi
echo ""

# -- 2. Transpile if out/ doesn't exist yet ----------------------------------
if [ ! -d "$ROOT/out" ]; then
	echo ">> Transpiling TypeScript source..."
	npm run transpile-client -- --transpile-only 2>&1 | tail -5
	echo ""
fi

# -- 3. Start the frontend ---------------------------------------------------
FRONTEND_PORT="${VSCODE_SESSIONS_PORT:-8081}"
echo ">> Starting Sessions Window on http://localhost:${FRONTEND_PORT}"
echo "    Connecting to agent host at ws://localhost:${BACKEND_PORT}"
echo ""

exec node "$ROOT/scripts/code-sessions-web.js" \
	--port "$FRONTEND_PORT" \
	--connect "ws://localhost:${BACKEND_PORT}" \
	--skip-welcome

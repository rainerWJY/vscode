#!/usr/bin/env bash
#
# start-backend.sh -- Start the OpenAIAgent Host WebSocket server (backend)
#
# Usage:
#   ./start-backend.sh
#
# Environment variables:
#   DEEPSEEK_API_KEY        Your DeepSeek API key (or OPENAI_API_KEY)
#   VSCODE_AGENT_HOST_PORT  Backend port (default: 8082)
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# -- 1. Load API key from .env if present ------------------------------------
if [ -f "$ROOT/.env" ]; then
	set -a
	. "$ROOT/.env"
	set +a
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
	echo "!! Error: DEEPSEEK_API_KEY or OPENAI_API_KEY is not set."
	echo ""
	echo "    Option A — add to ~/.zshrc (persists across all terminals):"
	echo "        echo 'export DEEPSEEK_API_KEY=\"sk-xxxxxxxxxxxxxxxx\"' >> ~/.zshrc"
	echo "        source ~/.zshrc"
	echo ""
	echo "    Option B — create a .env file in the project root (auto-loaded):"
	echo "        echo 'DEEPSEEK_API_KEY=\"sk-xxxxxxxxxxxxxxxx\"' > \"$ROOT/.env\""
	echo ""
	exit 1
fi

# -- 2. Transpile TypeScript source -> out/ ----------------------------------
echo ">> Transpiling TypeScript source..."
npm run transpile-client -- --transpile-only 2>&1 | tail -5
echo ""

# -- 3. Create logs directory -----------------------------------------------
LOGDIR="$ROOT/logs"
mkdir -p "$LOGDIR"
LOGFILE="$LOGDIR/agent-host-$(date +%Y%m%d-%H%M%S).log"

# Clean up logs older than 7 days
find "$LOGDIR" -name 'agent-host-*.log' -mtime +7 -delete 2>/dev/null || true

# -- 4. Start the agent host server (fast path: skip shell wrapper) ----------
PORT="${VSCODE_AGENT_HOST_PORT:-8082}"

# Resolve display model: $LLM_MODEL env → .openai-agent-config.json first tier → fallback
if [ -n "${LLM_MODEL:-}" ]; then
	MODEL="$LLM_MODEL"
elif [ -f "$ROOT/.openai-agent-config.json" ]; then
	MODEL="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/.openai-agent-config.json','utf8')).tiers[0].model)" 2>/dev/null)" || MODEL=""
	[ -z "$MODEL" ] && MODEL="(from config)"
else
	MODEL="deepseek-chat"
fi

KEY_STATUS="no"
if [ -n "${DEEPSEEK_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${LLM_API_KEY:-}" ]; then
	KEY_STATUS="yes"
fi
echo ">> Starting agent host on port ${PORT}..."
echo "   Model: ${MODEL} | Key present: ${KEY_STATUS}"
echo "   Log:   $LOGFILE"
echo ""

ENTRY="$ROOT/out/vs/platform/agentHost/node/agentHostServerMain.js"

NODE_ENV=development \
VSCODE_DEV=1 \
exec node "$ENTRY" \
	--port "$PORT" \
	--without-connection-token \
	--log info \
	>> "$LOGFILE" 2>&1

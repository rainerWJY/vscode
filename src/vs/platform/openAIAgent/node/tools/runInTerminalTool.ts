/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { TerminalManager } from '../services/agentHostTerminalManager.js';

/**
 * Execute a command in the terminal.
 *
 * Aligned with Copilot's `run_in_terminal` tool (workbench:
 * `RunInTerminalTool`). Our agent host runs in a standalone Node.js process
 * and uses `execSync` rather than a persistent xterm session, so async mode
 * and background terminal management are not supported here.
 *
 * Parameter schema and model description mirror the workbench tool's shape
 * for maximum model compatibility. Unused parameters (`mode`, `isBackground`,
 * `explanation`, `goal`) are accepted as no-ops.
 */
export const TOOL_RUN_IN_TERMINAL = defineTool({
	name: ToolName.RunInTerminal,
	description:
		'Execute a command in the terminal. ' +
		'This tool allows you to execute shell commands, preserving environment variables, working directory, and other context across multiple commands.\n\n' +
		'Command Execution:\n' +
		'- Use && to chain simple commands on one line\n' +
		'- Prefer pipelines | over temporary files for data flow\n' +
		'- Never create a sub-shell (eg. bash -c "command") unless explicitly asked\n\n' +
		'Directory Management:\n' +
		'- Prefer relative paths when navigating directories, only use absolute when the path is far away or the current cwd is not expected\n' +
		'- By default, shell and cwd are reused by subsequent sync commands\n' +
		'- Use $PWD for current directory references\n' +
		'- Consider using pushd/popd for directory stack management\n' +
		'- Supports directory shortcuts like ~ and -\n\n' +
		'Program Execution:\n' +
		'- Supports Python, Node.js, and other executables\n' +
		'- Install packages via package managers (brew, apt, etc.)\n' +
		'- Use which or command -v to verify command availability\n\n' +
		'Async Mode:\n' +
		'- Use mode=async ONLY for processes that should keep running while you do other work (servers, watchers, dev daemons)\n' +
		'- For one-shot long-running commands where you have nothing to do until they finish (package installs, builds, downloads, test suites), use mode=sync with a generous timeout (e.g. 600000 / 10 min for installs, longer for big builds) so the command can complete before your turn ends\n' +
		'- Returns a terminal ID for checking status and runtime later\n\n' +
		'Output Management:\n' +
		'- Output is automatically truncated if longer than 60KB to prevent context overflow\n' +
		'- Use head, tail, grep, awk to filter and limit output size\n' +
		'- For pager commands, disable paging: git --no-pager or add | cat\n' +
		'- Use wc -l to count lines before displaying large outputs\n\n' +
		'Best Practices:\n' +
		'- Quote variables: "$var" instead of $var to handle spaces\n' +
		'- Use find with -exec or xargs for file operations\n' +
		'- Be specific with commands to avoid excessive output\n' +
		'- Avoid printing credentials unless absolutely required\n' +
		'- NEVER run sleep or similar wait commands in a terminal. You will be automatically notified on your next turn when async terminal commands or timed-out sync commands complete or need input. Do NOT poll for completion.\n\n' +
		'Interactive Input Handling:\n' +
		'- When a terminal command is waiting for interactive input, do NOT suggest alternatives or ask the user whether to proceed. Instead, use the vscode_askQuestions tool to collect the needed values from the user, then send them.\n' +
		'- NEVER use vscode_askQuestions to request sensitive input such as passwords, passphrases, API keys, tokens, or other secrets — answers to that tool are sent through the model. If the prompt requires a secret, tell the user to type it directly into the terminal and stop; do not call vscode_askQuestions or send_to_terminal for that prompt.\n' +
		'- Send exactly one answer per prompt using send_to_terminal. Never send multiple answers in a single send.\n' +
		'- After each send, call get_terminal_output to read the next prompt before sending the next answer.\n' +
		'- Continue one prompt at a time until the command finishes.\n\n' +
		'Execution mode:\n' +
		"- mode='sync': wait for completion (optionally capped by timeout); if still running when timeout elapses, return with a terminal ID.\n" +
		"- mode='async': wait for an initial idle/output signal, then return with terminal output snapshot and ID. Timeout caps how long to wait for the initial idle/output signal.\n" +
		"- Prefer mode='sync' for commands that will prompt for interactive input (e.g., npm init, interactive installers, configuration wizards).\n\n" +
		'Timeout parameter: For one-shot long-running commands, set a generous timeout as a safety net (e.g. 600000 for installs, longer for big builds). Omit timeout only for processes that should run indefinitely (servers, daemons). If the timeout elapses, you get a terminal ID and can check output later.\n\n' +
		'Terminal notifications: When an async command finishes or a sync command times out, you will be automatically notified on your next turn with the exit code and terminal output. You will also be notified if the terminal needs input. Do NOT poll or sleep to wait for completion.\n\n' +
		'zsh pitfalls — these WILL cause errors or hangs:\n' +
		"- NEVER use bare == or === as separators (e.g. echo === triggers zsh equals expansion). Quote them: echo '==='\n" +
		'- NEVER use status as a variable name (it is read-only in zsh). Use exit_code or ret instead',
	parameters: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'The command to run in the terminal.',
			},
			explanation: {
				type: 'string',
				description: 'A one-sentence description of what the command does. This will be shown to the user before the command is run.',
			},
			goal: {
				type: 'string',
				description: 'A short description of the goal or purpose of the command (e.g., "Install dependencies", "Start development server").',
			},
			mode: {
				type: 'string',
				enum: ['sync', 'async'],
				enumDescriptions: [
					'Wait for completion up to timeout, then return with collected output. If still running at timeout, the terminal session continues in the background.',
					'Wait for an initial idle/output signal, then return with a terminal ID and output snapshot while the session may continue running.',
				],
				description: 'Execution mode for this command.',
			},
			isBackground: {
				type: 'boolean',
				description: 'Legacy execution mode flag. Deprecated in favor of "mode". If true, equivalent to mode=async. If false, equivalent to mode=sync.',
			},
			timeout: {
				type: 'number',
				description: 'Optional hard cap in milliseconds on how long the tool tracks the command before returning. Omit to let the command run to completion (recommended for package installs, builds, and long-running scripts). Use 0 to explicitly indicate no timeout.',
			},
		},
		required: ['command', 'explanation', 'goal'],
	},
	isDestructive: true,
	toolKind: 'shell',
});

// ---- handler (tool executor) ------------------------------------------------

/**
 * Create a `run_in_terminal` tool executor.
 *
 * Aligned with Copilot's `RunInTerminalTool.invoke()`:
 * - **Sync mode** (default): Uses `TerminalManager.execSync()` with persistent
 *   cwd tracking across commands (parses `cd` prefixes from commands).
 * - **Async mode**: Uses `TerminalManager.execAsync()` — spawns a detached
 *   child process, returns a `termId` for later polling via `get_terminal_output`.
 *
 * @param terminalManager — Manages persistent shell processes and cwd tracking
 * @param sessionUri — Session identifier for scoped terminal management
 */
export function createRunInTerminalExecutor(
	logService: ILogService,
	terminalManager: TerminalManager,
	sessionUri: string,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		const command = input.parameters.command as string;
		const explanation = input.parameters.explanation as string | undefined;
		const goal = input.parameters.goal as string | undefined;
		const mode = input.parameters.mode as string | undefined;
		const rawTimeout = input.parameters.timeout as number | undefined;

		logService.info(`[RunInTerminalTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, mode=${mode ?? 'sync'}, command="${command.substring(0, 200)}"`);
		logService.info(`[RunInTerminalTool] step=parse_params, explanation="${((explanation ?? '') as string).substring(0, 100)}", goal="${((goal ?? '') as string).substring(0, 100)}", timeout=${rawTimeout ?? 30000}`);

		// Sanity check: reject empty commands
		if (!command || command.trim().length === 0) {
			logService.warn(`[RunInTerminalTool] step=validate FAILED: empty command`);
			return {
				toolCallId: input.toolCallId,
				content: 'Error: command parameter is required and must be non-empty.',
				success: false,
			};
		}

		// Resolve effective mode
		const effectiveMode = mode === 'async' || input.parameters.isBackground === true ? 'async' : 'sync';
		const timeoutMs = rawTimeout !== undefined && rawTimeout > 0 ? rawTimeout : 30_000;

		logService.info(`[RunInTerminalTool] step=execute, effectiveMode=${effectiveMode}, command="${command.substring(0, 200)}", timeout=${timeoutMs}, cwd=${terminalManager.getCwd(sessionUri)}`);

		if (effectiveMode === 'async') {
			// ---- Async mode: spawn and return immediately with termId ----
			try {
				const { termId } = await terminalManager.execAsync(sessionUri, command);
				const elapsed = Date.now() - startTime;

				// Get initial output snapshot
				const initialOutput = terminalManager.getOutput(sessionUri, termId);

				logService.info(`[RunInTerminalTool] async done: termId=${termId.substring(0, 8)}, elapsed=${elapsed}ms, initialOutputLen=${initialOutput.output.length}`);

				// Copilot-aligned output: terminal ID + output + steering text
				const resultParts: string[] = [];
				resultParts.push(`Terminal ID: ${termId}`);
				if (initialOutput.output.trim().length > 0) {
					resultParts.push(initialOutput.output);
				}
				resultParts.push(`The command is running in the background. Use ${ToolName.GetTerminalOutput} with id="${termId}" to check its output later.`);
				resultParts.push(`Note: Command started in async mode. You will not be automatically notified when it completes. Poll with ${ToolName.GetTerminalOutput}.`);

				return {
					toolCallId: input.toolCallId,
					content: resultParts.join('\n'),
					success: true,
				};
			} catch (err) {
				const elapsed = Date.now() - startTime;
				const errMsg = err instanceof Error ? err.message : String(err);
				logService.error(`[RunInTerminalTool] async FAILED after ${elapsed}ms: ${errMsg}`);
				return {
					toolCallId: input.toolCallId,
					content: `Error starting async command: ${errMsg}`,
					success: false,
				};
			}
		}

		// ---- Sync mode: wait for completion with persistent cwd ----
		try {
			const result = await terminalManager.execSync(sessionUri, command, timeoutMs);
			const elapsed = Date.now() - startTime;
			const outputParts: string[] = [];

			if (result.stdout.trim().length > 0) {
				outputParts.push(result.stdout);
			}
			if (result.stderr.trim().length > 0) {
				outputParts.push(`(stderr): ${result.stderr}`);
			}

			const outputStr = outputParts.length > 0 ? outputParts.join('\n') : '(The command completed successfully with no output)';
			logService.info(`[RunInTerminalTool] sync done: exit=${result.exitCode}, elapsed=${elapsed}ms, outputLen=${outputStr.length}`);

			return {
				toolCallId: input.toolCallId,
				content: outputStr,
				success: result.exitCode === 0,
			};
		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[RunInTerminalTool] sync FAILED after ${elapsed}ms: ${errMsg}`);
			return {
				toolCallId: input.toolCallId,
				content: `Command failed: ${errMsg}`,
				success: false,
			};
		}
	};
}

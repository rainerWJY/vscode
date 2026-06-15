/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * Equivalent of Copilot's `ICustomInstructionsService` (subset).
 *
 * Detects whether a URI corresponds to known instruction or skill file patterns,
 * such as `.github/copilot-instructions.md`, `*.instructions.md`, `*.prompt.md`,
 * `*.agent.md`, and `SKILL.md`.
 *
 * These files are treated as "special" by the tool system — they contain
 * instructions/skills for the agent, not source code.
 */
export interface IAgentHostInstructionsService {

	/**
	 * Check whether a file is an external instructions file
	 * (e.g. `.github/copilot-instructions.md`, `*.instructions.md`, `*.prompt.md`).
	 */
	isExternalInstructionsFile(uri: URI): boolean;

	/**
	 * Check whether a file is a `SKILL.md` file (skill definition).
	 */
	isSkillFile(uri: URI): boolean;

	/**
	 * Check whether a file is an agent definition file (`*.agent.md`).
	 */
	isAgentFile(uri: URI): boolean;
}

// ---- patterns (matching Copilot's promptTypes.ts) ---------------------------

const COPILOT_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';
const COPILOT_PERSONAL_INSTRUCTIONS_PATH = '.copilot/copilot-instructions.md';
const INSTRUCTION_FILE_EXTENSION = '.instructions.md';
const PROMPT_FILE_EXTENSION = '.prompt.md';
const AGENT_FILE_EXTENSION = '.agent.md';
const SKILL_FILENAME = 'SKILL.md';

export class AgentHostInstructionsService implements IAgentHostInstructionsService {

	declare _serviceBrand: undefined;

	isExternalInstructionsFile(uri: URI): boolean {
		const pathStr = uri.path;

		// Check for well-known paths
		if (pathStr.endsWith(COPILOT_INSTRUCTIONS_PATH)) {
			return true;
		}
		if (pathStr.endsWith(COPILOT_PERSONAL_INSTRUCTIONS_PATH)) {
			return true;
		}

		// Check for file extension patterns
		if (pathStr.endsWith(INSTRUCTION_FILE_EXTENSION)) {
			return true;
		}
		if (pathStr.endsWith(PROMPT_FILE_EXTENSION)) {
			return true;
		}

		return false;
	}

	isSkillFile(uri: URI): boolean {
		return uri.path.split('/').pop() === SKILL_FILENAME;
	}

	isAgentFile(uri: URI): boolean {
		return uri.path.endsWith(AGENT_FILE_EXTENSION);
	}
}

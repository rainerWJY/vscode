/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase, basename, dirname } from '../../../../base/common/resources.js';
import { ResourceSet } from '../../../../base/common/map.js';
import type { IAgentHostFileSystemService } from './agentHostFileSystemService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

// ---- types (matching Copilot's promptTypes.ts + customInstructionsService.ts) --

export enum PromptsType {
	instructions = 'instructions',
	prompt = 'prompt',
	agent = 'agent',
	skill = 'skill',
}

export const INSTRUCTIONS_LOCATION_KEY = 'chat.instructionsFilesLocations';
export const SKILLS_LOCATION_KEY = 'chat.agentSkillsLocations';

export const WORKSPACE_SKILL_FOLDERS = ['.github/skills', '.claude/skills'];
export const PERSONAL_SKILL_FOLDERS = ['.copilot/skills', '.claude/skills'];

export const COPILOT_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';
export const COPILOT_PERSONAL_INSTRUCTIONS_PATH = '.copilot/copilot-instructions.md';

export const PROMPT_FILE_EXTENSION = '.prompt.md';
export const INSTRUCTION_FILE_EXTENSION = '.instructions.md';
export const AGENT_FILE_EXTENSION = '.agent.md';
export const SKILL_FILENAME = 'SKILL.md';

export interface ICustomInstructions {
	readonly kind: CustomInstructionsKind;
	readonly content: IInstruction[];
	readonly reference: URI;
}

export enum CustomInstructionsKind {
	File,
	Setting,
}

export interface IInstruction {
	readonly languageId?: string;
	readonly instruction: string;
}

export interface IExtensionPromptFile {
	uri: URI;
	type: PromptsType;
	extensionId?: string;
}

export const enum SkillStorage {
	Extension = 'extension',
	Internal = 'internal',
	Personal = 'personal',
	Workspace = 'workspace',
}

export interface ISkillInfo {
	readonly skillName: string;
	readonly skillFolderUri: URI;
	readonly storage: SkillStorage;
}

export interface IInstructionIndexFile {
	readonly instructions: ResourceSet;
	readonly skills: ResourceSet;
	readonly skillFolders: ResourceSet;
	readonly agents: Set<string>;
}

// ---- service interface (aligned with Copilot's ICustomInstructionsService) -------

/**
 * Aligned with Copilot's `ICustomInstructionsService`.
 *
 * Detects instruction/skill/agent files, reads their content,
 * and manages the discovery of prompt files across workspaces.
 *
 * What's implemented:
 * - File detection: isExternalInstructionsFile, isExternalInstructionsFolder,
 *   isSkillFile, isSkillMdFile, isAgentFile
 * - Skill info: getSkillInfo, getSkillDirectory, getSkillName
 * - File reading: fetchInstructionsFromFile, fetchInstructionsFromSetting
 * - Instruction discovery: getAgentInstructions
 * - Index parsing: parseInstructionIndexFile
 *
 * What's NOT implemented (agent host has no extension system):
 * - refreshExtensionPromptFiles (stub — returns empty)
 * - getExtensionSkillInfo (stub — returns undefined)
 */
export interface IAgentHostInstructionsService {
	readonly _serviceBrand: undefined;

	/** Read instructions from a user setting key. */
	fetchInstructionsFromSetting(configKey: string): Promise<ICustomInstructions[]>;

	/** Read instructions from a single file URI. */
	fetchInstructionsFromFile(fileUri: URI): Promise<ICustomInstructions | undefined>;

	/** Find well-known instruction files (.github/copilot-instructions.md etc.) */
	getAgentInstructions(): Promise<URI[]>;

	/** Parse an XML-format instruction index file (from prompts/*.md indices). */
	parseInstructionIndexFile(promptFileIndexText: string): IInstructionIndexFile;

	/** Check whether a URI is an external instructions file. */
	isExternalInstructionsFile(uri: URI): Promise<boolean>;

	/** Check whether a URI is under an external instructions folder. */
	isExternalInstructionsFolder(uri: URI): boolean;

	/** Check whether a URI is inside a skill folder. */
	isSkillFile(uri: URI): boolean;

	/** Check whether a URI points to a SKILL.md file inside a skill folder. */
	isSkillMdFile(uri: URI): boolean;

	/** Get the skill directory URI for a given file inside a skill folder. */
	getSkillDirectory(uri: URI): URI | undefined;

	/** Get the skill name for a given file inside a skill folder. */
	getSkillName(uri: URI): string | undefined;

	/** Get full skill info for a given URI. */
	getSkillInfo(uri: URI): ISkillInfo | undefined;

	/** Get extension-contributed skill info (always undefined without extension system). */
	getExtensionSkillInfo(uri: URI): (ISkillInfo & { extensionId?: string }) | undefined;

	/** Refresh cached extension prompt files (no-op without extension system). */
	refreshExtensionPromptFiles(): Promise<void>;

	/** Check whether a file is an agent definition file (*.agent.md). */
	isAgentFile(uri: URI): boolean;
}

// ---- implementation ---------------------------------------------------------

export class AgentHostInstructionsService implements IAgentHostInstructionsService {

	declare _serviceBrand: undefined;

	private _extensionPromptFilesCache: IExtensionPromptFile[] | undefined;
	private _userHome: URI | undefined;
	private _workspaceRoots: URI[] = [];

	constructor(
		private readonly _fileSystemService: IAgentHostFileSystemService,
		private readonly _logService: ILogService,
	) {
		// Discover workspace roots from process.cwd()
		this._workspaceRoots = [URI.file(process.cwd())];
		try {
			this._userHome = URI.file(require('os').homedir());
		} catch {
			this._userHome = URI.file(process.env['HOME'] || process.env['USERPROFILE'] || '/');
		}
		this._logService.trace(`[AgentHostInstructionsService] initialized: ${this._workspaceRoots.length} workspace roots, userHome=${this._userHome?.fsPath}`);
	}

	// allow-any-unicode-next-line
	// ── file detection ───────────────────────────────────────────────────────

	async isExternalInstructionsFile(uri: URI): Promise<boolean> {
		// Check vscode-userdata scheme (for cloud-synced instructions)
		if (uri.scheme === Schemas.vscodeUserData && uri.path.endsWith(INSTRUCTION_FILE_EXTENSION)) {
			return true;
		}

		// Check well-known paths
		if (uri.path.endsWith(COPILOT_INSTRUCTIONS_PATH) || uri.path.endsWith(COPILOT_PERSONAL_INSTRUCTIONS_PATH)) {
			return true;
		}

		// Check by file extension
		if (uri.path.endsWith(INSTRUCTION_FILE_EXTENSION) || uri.path.endsWith(PROMPT_FILE_EXTENSION)) {
			return true;
		}

		// Check if inside known instruction/skill locations
		if (this._isUnderSkillFolder(uri)) {
			return true;
		}

		return false;
	}

	isExternalInstructionsFolder(uri: URI): boolean {
		return this._isUnderSkillFolder(uri);
	}

	isSkillFile(uri: URI): boolean {
		return this._getSkillInfo(uri) !== undefined;
	}

	isSkillMdFile(uri: URI): boolean {
		return this.isSkillFile(uri) && basename(uri).toLowerCase() === 'skill.md';
	}

	isAgentFile(uri: URI): boolean {
		return uri.path.endsWith(AGENT_FILE_EXTENSION);
	}

	// allow-any-unicode-next-line
	// ── skill info ───────────────────────────────────────────────────────────

	getSkillDirectory(uri: URI): URI | undefined {
		return this._getSkillInfo(uri)?.skillFolderUri;
	}

	getSkillName(uri: URI): string | undefined {
		return this._getSkillInfo(uri)?.skillName;
	}

	getSkillInfo(uri: URI): ISkillInfo | undefined {
		return this._getSkillInfo(uri);
	}

	getExtensionSkillInfo(_uri: URI): (ISkillInfo & { extensionId?: string }) | undefined {
		// No extension system in agent host
		return undefined;
	}

	// allow-any-unicode-next-line
	// ── instruction reading ──────────────────────────────────────────────────

	async fetchInstructionsFromFile(fileUri: URI): Promise<ICustomInstructions | undefined> {
		this._logService.trace(`[AgentHostInstructionsService] fetchInstructionsFromFile: ${fileUri.toString()}`);
		try {
			const content = await this._fileSystemService.readFile(fileUri);
			const text = new TextDecoder().decode(content);
			const instruction = text.trim();
			if (!instruction) {
				return undefined;
			}
			return {
				kind: CustomInstructionsKind.File,
				content: [{ instruction, languageId: undefined }],
				reference: fileUri,
			};
		} catch {
			return undefined;
		}
	}

	async fetchInstructionsFromSetting(_configKey: string): Promise<ICustomInstructions[]> {
		// Settings-based instructions require IConfigurationService — not yet available.
		// Returns empty array; callers should handle gracefully.
		return [];
	}

	async getAgentInstructions(): Promise<URI[]> {
		this._logService.trace(`[AgentHostInstructionsService] getAgentInstructions`);
		const result: URI[] = [];

		for (const root of this._workspaceRoots) {
			try {
				const workspaceInstructionUri = extUriBiasedIgnorePathCase.joinPath(root, COPILOT_INSTRUCTIONS_PATH);
				await this._fileSystemService.stat(workspaceInstructionUri);
				result.push(workspaceInstructionUri);
				this._logService.trace(`[AgentHostInstructionsService] found: ${workspaceInstructionUri.toString()}`);
			} catch {
				// file doesn't exist — skip
			}
		}

		if (this._userHome) {
			try {
				const personalInstructionUri = extUriBiasedIgnorePathCase.joinPath(this._userHome, COPILOT_PERSONAL_INSTRUCTIONS_PATH);
				await this._fileSystemService.stat(personalInstructionUri);
				result.push(personalInstructionUri);
				this._logService.trace(`[AgentHostInstructionsService] found personal: ${personalInstructionUri.toString()}`);
			} catch {
				// file doesn't exist — skip
			}
		}

		this._logService.trace(`[AgentHostInstructionsService] getAgentInstructions: ${result.length} file(s)`);
		return result;
	}

	// allow-any-unicode-next-line
	// ── index parsing ────────────────────────────────────────────────────────

	parseInstructionIndexFile(content: string): IInstructionIndexFile {
		return new InstructionIndexFile(content);
	}

	// allow-any-unicode-next-line
	// ── extension prompt files (no-op) ──────────────────────────────────────

	async refreshExtensionPromptFiles(): Promise<void> {
		this._extensionPromptFilesCache = [];
	}

	// allow-any-unicode-next-line
	// ── internal helpers ─────────────────────────────────────────────────────

	private _getSkillInfo(uri: URI): ISkillInfo | undefined {
		if (uri.scheme !== Schemas.file) {
			return undefined;
		}

		const fsPath = uri.fsPath;

		// Check workspace skill folders (.github/skills/, .claude/skills/)
		for (const root of this._workspaceRoots) {
			for (const folder of WORKSPACE_SKILL_FOLDERS) {
				const folderFsPath = path.join(root.fsPath, folder);
				const info = this._checkSkillFolder(fsPath, folderFsPath);
				if (info) {
					return { ...info, storage: SkillStorage.Workspace };
				}
			}
		}

		// Check personal skill folders (.copilot/skills/, .claude/skills/)
		if (this._userHome) {
			for (const folder of PERSONAL_SKILL_FOLDERS) {
				const folderFsPath = path.join(this._userHome.fsPath, folder);
				const info = this._checkSkillFolder(fsPath, folderFsPath);
				if (info) {
					return { ...info, storage: SkillStorage.Personal };
				}
			}
		}

		return undefined;
	}

	/**
	 * Given a target file path and a skill folder path (e.g. /root/.github/skills),
	 * check if the target is under a subfolder of the skill folder and return its info.
	 *
	 * Skill structure: .github/skills/<skill-name>/SKILL.md
	 */
	private _checkSkillFolder(
		targetFsPath: string,
		skillFolderFsPath: string,
	): { skillName: string; skillFolderUri: URI } | undefined {
		if (!targetFsPath.startsWith(skillFolderFsPath + path.sep) && targetFsPath !== skillFolderFsPath) {
			return undefined;
		}

		const relative = path.relative(skillFolderFsPath, targetFsPath);
		const segments = relative.split(path.sep).filter(s => s.length > 0);
		if (segments.length === 0) {
			return undefined;
		}

		// First segment is the skill name
		const skillName = segments[0];
		const skillFolderUri = URI.file(path.join(skillFolderFsPath, skillName));
		return { skillName, skillFolderUri };
	}

	private _isUnderSkillFolder(uri: URI): boolean {
		return this._getSkillInfo(uri) !== undefined;
	}
}

// ---- InstructionIndexFile parser ------------------------------------------------

class InstructionIndexFile implements IInstructionIndexFile {

	private _instructions: ResourceSet | undefined;
	private _skills: ResourceSet | undefined;
	private _skillFolders: ResourceSet | undefined;
	private _agents: Set<string> | undefined;

	constructor(public readonly content: string) { }

	get instructions(): ResourceSet {
		if (this._instructions === undefined) {
			this._instructions = this._getURIsFromFilePaths(this._getValuesInIndexFile('instructions', 'instruction', 'file'));
		}
		return this._instructions;
	}

	get skills(): ResourceSet {
		if (this._skills === undefined) {
			this._skills = this._getURIsFromFilePaths(this._getValuesInIndexFile('skills', 'skill', 'file'));
		}
		return this._skills;
	}

	get skillFolders(): ResourceSet {
		if (this._skillFolders === undefined) {
			this._skillFolders = new ResourceSet();
			for (const skillUri of this.skills) {
				this._skillFolders.add(dirname(skillUri));
			}
		}
		return this._skillFolders;
	}

	get agents(): Set<string> {
		if (this._agents === undefined) {
			this._agents = new Set(this._getValuesInIndexFile('agents', 'agent', 'file'));
		}
		return this._agents;
	}

	private _getValuesInIndexFile(listElementName: string, elementName: string, propertyName: string): string[] {
		const result: string[] = [];
		const lists = xmlContents(this.content, listElementName);
		for (const list of lists) {
			const elements = xmlContents(list, elementName);
			for (const element of elements) {
				const values = xmlContents(element, propertyName);
				if (values.length > 0) {
					result.push(values[0]);
				}
			}
		}
		return result;
	}

	private _getURIsFromFilePaths(filePaths: string[]): ResourceSet {
		const result = new ResourceSet();
		for (const fp of filePaths) {
			try {
				const uri = URI.file(fp);
				result.add(uri);
				// Also add vscode-userdata variant for matching
				result.add(URI.from({ scheme: Schemas.vscodeUserData, path: uri.path }));
			} catch {
				// skip invalid paths
			}
		}
		return result;
	}
}

// ---- XML helper (matching Copilot's xmlContents utility) -----------------------

function xmlContents(text: string, tag: string): string[] {
	const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
	const matches: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		matches.push(match[1].trim());
	}
	return matches;
}

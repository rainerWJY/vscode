/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';

// ---- configuration ----------------------------------------------------------

export interface IOpenAIAgentConfig {
	/** API base URL (default: https://api.deepseek.com/v1). */
	readonly baseUrl?: string;
	/** API key for the provider. */
	readonly apiKey?: string;
	/** Model identifier (default: deepseek-chat). */
	readonly model?: string;
	/** System prompt to inject at the start of every conversation. */
	readonly systemPrompt?: string;
	/** Maximum number of tool-calling rounds before forcing a stop. */
	readonly maxToolCallRounds?: number;
	/** Custom HTTP headers to include in every request. */
	readonly headers?: Record<string, string>;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_MAX_ROUNDS = 30;

// ---- message types ----------------------------------------------------------

export interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
	/** Anthropic-style thinking/reasoning block — set for assistant messages that contained reasoning. */
	reasoning_content?: string;
}

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenAIToolDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

// ---- stream events ----------------------------------------------------------

export type OpenAIStreamEvent =
	| { type: 'delta'; content: string }
	| { type: 'reasoning'; content: string }
	| { type: 'toolCallDelta'; id: string; name: string; arguments: string }
	| { type: 'finish'; finishReason: string; usage?: OpenAITokenUsage };

export interface OpenAITokenUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

// ---- API client -------------------------------------------------------------

export class OpenAIApiClient {
	readonly baseUrl: string;
	readonly model: string;
	readonly maxToolCallRounds: number;
	private readonly _apiKey: string;
	private readonly _headers: Record<string, string>;
	private readonly _systemPrompt: string;

	constructor(config: IOpenAIAgentConfig) {
		this.baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? DEFAULT_BASE_URL;
		this._apiKey = config.apiKey ?? '';
		this.model = config.model ?? DEFAULT_MODEL;
		this._systemPrompt = config.systemPrompt ?? '';
		this.maxToolCallRounds = config.maxToolCallRounds ?? DEFAULT_MAX_ROUNDS;
		this._headers = {
			'Content-Type': 'application/json',
			...(this._apiKey ? { 'Authorization': `Bearer ${this._apiKey}` } : {}),
			...(config.headers ?? {}),
		};
	}

	get systemPrompt(): string { return this._systemPrompt; }

	/**
	 * Stream a chat completion from the OpenAI-compatible API.
	 *
	 * Yields {@link OpenAIStreamEvent} items as the response streams in.
	 * Callers should iterate with `for await...of` to process deltas
	 * (text, reasoning, tool calls) and receive a terminal `finish` event.
	 */
	async *streamChat(
		messages: OpenAIChatMessage[],
		tools: OpenAIToolDef[],
		token: CancellationToken,
	): AsyncIterable<OpenAIStreamEvent> {
		const body = JSON.stringify({
			model: this.model,
			messages,
			stream: true,
			tools: tools.length > 0 ? tools : undefined,
			tool_choice: tools.length > 0 ? 'auto' : undefined,
		});

		const url = new URL('/chat/completions', this.baseUrl);
		const signal = token.isCancellationRequested
			? undefined
			: AbortSignal.timeout?.(5 * 60 * 1000);

		if (token.isCancellationRequested) {
			throw new Error('Cancelled');
		}

		const response = await this._fetch(url.toString(), {
			method: 'POST' as const,
			headers: this._headers,
			body,
			signal,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`OpenAI API error ${response.status}: ${text}`);
		}

		if (!response.body) {
			throw new Error('OpenAI API returned no response body');
		}

		const events = this._parseSSEStream(response.body, token);
		for await (const event of events) {
			yield event;
		}
	}

	private async *_parseSSEStream(
		stream: ReadableStream<Uint8Array>,
		token: CancellationToken,
	): AsyncIterable<OpenAIStreamEvent> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

		for await (const chunk of this._readableStreamAsyncIterator(reader, token)) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split('\n');
			// Keep the last (potentially incomplete) line in the buffer
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith('data: ')) {
					continue;
				}
				const data = trimmed.slice(6);
				if (data === '[DONE]') {
					yield { type: 'finish', finishReason: 'stop' };
					return;
				}

				try {
					const parsed = JSON.parse(data);
					const choice = parsed.choices?.[0];
					if (!choice) {
						continue;
					}

					const delta = choice.delta;

					// Reasoning content (DeepSeek, some OpenAI-compatible providers)
					if (delta?.reasoning_content) {
						yield { type: 'reasoning', content: delta.reasoning_content };
					}

					// Text content
					if (delta?.content) {
						yield { type: 'delta', content: delta.content };
					}

					// Tool calls
					if (delta?.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							let pending = pendingToolCalls.get(idx);
							if (!pending) {
								pending = { id: tc.id ?? '', name: '', arguments: '' };
								pendingToolCalls.set(idx, pending);
							}
							if (tc.id) { pending.id = tc.id; }
							if (tc.function?.name) { pending.name = tc.function.name; }
							if (tc.function?.arguments) { pending.arguments += tc.function.arguments; }
						}
					}

					// Finish reason
					if (choice.finish_reason) {
						if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
							// Emit tool call deltas and finish
							for (const [, tc] of pendingToolCalls) {
								yield { type: 'toolCallDelta', id: tc.id, name: tc.name, arguments: tc.arguments };
							}
							pendingToolCalls.clear();
						}
						yield {
							type: 'finish',
							finishReason: choice.finish_reason,
							usage: parsed.usage,
						};
						return;
					}
				} catch {
					// skip malformed lines
				}
			}
		}

		// Stream ended without [DONE] or finish_reason
		yield { type: 'finish', finishReason: 'stop' };
	}

	/**
	 * Wraps a ReadableStreamDefaultReader into an async iterable, respecting
	 * cancellation.
	 */
	private async *_readableStreamAsyncIterator(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		token: CancellationToken,
	): AsyncIterable<Uint8Array> {
		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) { break; }
				if (value) { yield value; }
			}
		} finally {
			reader.cancel().catch(() => { /* best-effort */ });
		}
	}

	private async _fetch(url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<import('undici').Response> {
		const { fetch } = await import('undici') as typeof import('undici');
		return fetch(url, init);
	}
}

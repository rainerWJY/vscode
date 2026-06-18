/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentRegistry } from '../../node/agentTypes.js';

// ==============================================================================
// Suite: AgentRegistry
// ==============================================================================

suite('AgentRegistry', () => {

	test('should start empty', () => {
		const registry = new AgentRegistry();
		assert.strictEqual(registry.getAll().length, 0);
	});

	test('should return undefined for unknown agent', () => {
		const registry = new AgentRegistry();
		assert.strictEqual(registry.get('Explore'), undefined);
	});

	test('should register and retrieve an agent', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Explore', description: 'Code research agent' });
		const agent = registry.get('Explore');
		assert.ok(agent);
		assert.strictEqual(agent.name, 'Explore');
		assert.strictEqual(agent.description, 'Code research agent');
	});

	test('should return all registered agents', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Explore', body: 'Research' });
		registry.register({ name: 'Ask', body: 'Answer' });
		assert.strictEqual(registry.getAll().length, 2);
	});

	test('should overwrite existing agent with same name', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Explore', model: 'model-a' });
		registry.register({ name: 'Explore', model: 'model-b' });
		const agent = registry.get('Explore');
		assert.strictEqual(agent?.model, 'model-b');
		assert.strictEqual(registry.getAll().length, 1);
	});

	test('should register agent with tool whitelist', () => {
		const registry = new AgentRegistry();
		registry.register({
			name: 'ReadOnly',
			tools: ['read_file', 'grep_search', 'file_search', 'list_dir'],
		});
		const agent = registry.get('ReadOnly');
		assert.ok(agent?.tools);
		assert.strictEqual(agent.tools.length, 4);
		assert.ok(agent.tools.includes('read_file'));
	});

	test('should register agent with model override', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Fast', model: 'deepseek-chat' });
		assert.strictEqual(registry.get('Fast')?.model, 'deepseek-chat');
	});

	test('should register agent with body instructions', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Custom', body: 'You are a specialized agent.' });
		assert.strictEqual(registry.get('Custom')?.body, 'You are a specialized agent.');
	});

	test('should unregister an agent', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Explore' });
		assert.ok(registry.get('Explore'));
		registry.unregister('Explore');
		assert.strictEqual(registry.get('Explore'), undefined);
	});

	test('should not throw when unregistering non-existent agent', () => {
		const registry = new AgentRegistry();
		registry.unregister('NonExistent');
		assert.strictEqual(registry.getAll().length, 0);
	});

	test('should clear all agents', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'A' });
		registry.register({ name: 'B' });
		registry.register({ name: 'C' });
		assert.strictEqual(registry.getAll().length, 3);
		registry.clear();
		assert.strictEqual(registry.getAll().length, 0);
	});

	test('should handle agentOnly flag', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Internal', agentOnly: true });
		assert.strictEqual(registry.get('Internal')?.agentOnly, true);
	});

	test('should handle userInvocable flag', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Public', userInvocable: true });
		assert.strictEqual(registry.get('Public')?.userInvocable, true);
	});

	test('should allow registering multiple agents with different names', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Explore', body: 'search' });
		registry.register({ name: 'Ask', body: 'qa' });
		registry.register({ name: 'Plan', body: 'planning' });
		assert.strictEqual(registry.getAll().length, 3);
		const names = registry.getAll().map(a => a.name);
		assert.ok(names.includes('Explore'));
		assert.ok(names.includes('Ask'));
		assert.ok(names.includes('Plan'));
	});

	test('should not share state between instances', () => {
		const regA = new AgentRegistry();
		const regB = new AgentRegistry();
		regA.register({ name: 'Explore' });
		assert.strictEqual(regA.getAll().length, 1);
		assert.strictEqual(regB.getAll().length, 0);
	});
});

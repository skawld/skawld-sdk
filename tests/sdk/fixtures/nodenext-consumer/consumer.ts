/**
 * NodeNext consumer fixture.
 *
 * Imports from all published subpaths under moduleResolution: NodeNext.
 * Each import is referenced so TypeScript does not elide it.
 * This file is compiled by the guardrail test to verify zero TS2834/TS2835 errors.
 */

import { Agent, loadConfig } from "@skawld/agent-sdk";
import type { LoadedConfig } from "@skawld/agent-sdk";
import { AnthropicProvider } from "@skawld/agent-sdk/providers";
import type { Tool } from "@skawld/agent-sdk/tools";
import type { SessionStore } from "@skawld/agent-sdk/sessions";
import { PermissionEngine } from "@skawld/agent-sdk/permissions";

// Reference each export so TypeScript does not elide the imports.
const _agent: typeof Agent = Agent;
const _provider: typeof AnthropicProvider = AnthropicProvider;
const _engine: typeof PermissionEngine = PermissionEngine;
const _loadConfig: typeof loadConfig = loadConfig;

// Type-only references — these must be used as types, not values.
type _Tool = Tool;
type _SessionStore = SessionStore;
type _LoadedConfig = LoadedConfig;

// Satisfy "declared but never read" for value references.
void _agent;
void _provider;
void _engine;
void _loadConfig;

/**
 * Model rows for tests.
 *
 * Deliberately local: the plugin ships no built-in roster, so a test that needs
 * models to exist has to state them itself rather than borrow a production
 * list. Keeping one copy here means a change to the shipped catalog can never
 * silently rewrite an assertion.
 *
 * @module dsh-astudio-connect/tests/support/models
 */

import type { AStudioModelInfo } from '../../src/catalog.ts'

/** A small mixed roster: one reasoning model, one plain one, one unknown id. */
export const SAMPLE_MODELS: readonly AStudioModelInfo[] = [
  {
    id: 'spark-x2.5',
    name: 'Spark X2.5',
    supportsImages: false,
    reasoning: { supports: true, supportedEfforts: ['high'], canDisableThinking: true },
    contextWindow: 262144,
    maxTokens: 100000,
  },
  {
    id: 'xopglm52',
    name: 'GLM-5.2',
    supportsImages: false,
    reasoning: { supports: true, supportedEfforts: ['high', 'max'], canDisableThinking: true },
    contextWindow: 1048576,
    maxTokens: 100000,
  },
  {
    id: 'xopdeepseekv4pro',
    name: 'DeepSeek V4 Pro',
    supportsImages: false,
    reasoning: { supports: false },
    contextWindow: 1048576,
    maxTokens: 100000,
  },
]

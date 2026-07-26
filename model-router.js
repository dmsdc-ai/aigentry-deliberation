// model-router.js
// Model selection per browser LLM provider.
//
// ponytail: static map. The previous keyword-scoring engine (~120 lines of
// category/complexity heuristics) was ignored by 9 of 11 providers, which all
// returned "highest-end model" unconditionally. Model strings below are the
// dropdown labels port.switchModel types into each provider's web UI — some are
// stale and need UI verification; verify against the live UI before editing.
const MODEL_FOR_PROVIDER = {
  chatgpt: 'gpt-5.4',
  claude: 'opus',
  gemini: '3.1 Pro Preview',
  deepseek: 'DeepSeek-R1',
  grok: 'grok-3',
  mistral: 'Mistral Large',
  poe: 'Claude-3.5-Opus',
  qwen: 'Qwen-Max',
  huggingchat: 'Qwen/QwQ-32B',
  copilot: 'GPT-4.5',
  perplexity: 'sonar-pro',
};

/**
 * Model selection for a turn. Callers use `.model` (skipped when 'default')
 * and `.reason` (shown in the CLI speaker guide).
 * @param {object} _state - Deliberation state (unused; kept for call-site shape)
 * @param {string} _speaker - Current speaker identifier (unused)
 * @param {string} provider - The AI provider to use
 * @returns {{ model: string, reason: string }}
 */
export function getModelSelectionForTurn(_state, _speaker, provider) {
  const model = MODEL_FOR_PROVIDER[provider];
  return model
    ? { model, reason: 'Highest-end model for provider' }
    : { model: 'default', reason: `Unknown provider: ${provider}` };
}

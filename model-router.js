// model-router.js
// Dynamic model selection based on deliberation prompt context

const CATEGORY_KEYWORDS = {
  reasoning: [
    'analyze', 'analysis', 'debug', 'debugging', 'complex', 'logic', 'reasoning',
    'problem', 'solve', 'evaluate', 'assess', 'critique', 'argument', 'inference',
    'contradiction', 'flaw', 'why', 'explain', 'cause', 'effect', 'implication',
    'consequence', 'tradeoff', 'compare', 'pros', 'cons', 'decision', 'strategy',
    'architecture', 'design pattern', 'refactor', 'optimize', 'performance',
  ],
  coding: [
    'code', 'implement', 'function', 'class', 'module', 'api', 'library',
    'algorithm', 'data structure', 'typescript', 'javascript', 'python', 'rust',
    'build', 'deploy', 'test', 'unit test', 'integration', 'bug', 'fix', 'error',
    'syntax', 'runtime', 'compile', 'script', 'program', 'software', 'feature',
    'endpoint', 'schema', 'database', 'query', 'sql', 'migration', 'lint',
  ],
  creative: [
    'write', 'writing', 'design', 'brainstorm', 'idea', 'creative', 'story',
    'narrative', 'style', 'tone', 'voice', 'draft', 'outline', 'concept',
    'vision', 'imagine', 'suggest', 'propose', 'generate', 'name', 'brand',
    'ui', 'ux', 'interface', 'experience', 'aesthetic', 'layout', 'visual',
  ],
  research: [
    'research', 'find', 'search', 'fact', 'data', 'statistic', 'source',
    'reference', 'study', 'survey', 'report', 'paper', 'documentation', 'docs',
    'compare', 'benchmark', 'review', 'overview', 'summary', 'what is', 'who is',
    'history', 'background', 'context', 'information', 'knowledge',
  ],
  simple: [
    'yes', 'no', 'confirm', 'ok', 'okay', 'agree', 'disagree', 'correct',
    'hello', 'hi', 'thanks', 'thank you', 'sure', 'got it', 'understood',
    'clarify', 'quick', 'brief', 'simple', 'basic',
  ],
};

const COMPLEXITY_KEYWORDS = {
  high: [
    'complex', 'complicated', 'difficult', 'challenging', 'sophisticated',
    'advanced', 'deep', 'thorough', 'comprehensive', 'exhaustive', 'detailed',
    'multi-step', 'multi-faceted', 'nuanced', 'ambiguous', 'architecture',
    'system', 'scalable', 'distributed', 'concurrent', 'critical', 'production',
  ],
  low: [
    'simple', 'basic', 'quick', 'brief', 'short', 'easy', 'trivial',
    'straightforward', 'obvious', 'clear', 'confirm', 'yes', 'no', 'agree',
    'ok', 'sure', 'hello', 'hi',
  ],
};

const ROLE_KEYWORDS = {
  critic: 'reasoning',
  implementer: 'coding',
  mediator: 'creative',
  researcher: 'research',
};

/**
 * Count keyword matches in text for a given keyword list.
 */
function countMatches(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.reduce((count, kw) => {
    return count + (lower.includes(kw.toLowerCase()) ? 1 : 0);
  }, 0);
}

/**
 * Analyze deliberation context to determine category and complexity.
 * @param {string} topic - The deliberation topic
 * @param {string} recentLog - Recent log text from deliberation
 * @param {string} role - The speaker's role
 * @returns {{ category: string, complexity: string }}
 */
export function analyzePromptContext(topic, recentLog, role) {
  const text = `${topic} ${recentLog}`;

  // Role-based category hint
  let roleCategory = null;
  if (role) {
    const lowerRole = role.toLowerCase();
    for (const [keyword, category] of Object.entries(ROLE_KEYWORDS)) {
      if (lowerRole.includes(keyword)) {
        roleCategory = category;
        break;
      }
    }
  }

  // Keyword-based category scoring
  const scores = {};
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[category] = countMatches(text, keywords);
  }

  // Find top category by keyword score
  let topCategory = 'simple';
  let topScore = 0;
  for (const [category, score] of Object.entries(scores)) {
    if (score > topScore) {
      topScore = score;
      topCategory = category;
    }
  }

  // Role hint takes precedence if no strong keyword signal
  const category = topScore >= 2 ? topCategory : (roleCategory || topCategory);

  // Complexity detection
  const highCount = countMatches(text, COMPLEXITY_KEYWORDS.high);
  const lowCount = countMatches(text, COMPLEXITY_KEYWORDS.low);

  let complexity;
  if (highCount > lowCount && highCount >= 1) {
    complexity = 'high';
  } else if (lowCount > 0 && highCount === 0) {
    complexity = 'low';
  } else {
    complexity = 'medium';
  }

  return { category, complexity };
}

/**
 * Select the optimal model for a given provider based on category and complexity.
 * @param {string} provider - The AI provider identifier
 * @param {string} category - Prompt category
 * @param {string} complexity - Prompt complexity
 * @returns {{ model: string, reason: string }}
 */
export function selectModelForProvider(provider, category, complexity) {
  const isHighReasoning = category === 'reasoning' || complexity === 'high';
  const isSimple = complexity === 'low' || category === 'simple';
  const isCoding = category === 'coding';

  switch (provider) {
    case 'chatgpt': {
      if (isHighReasoning || isCoding) return { model: 'gpt-5.4', reason: 'High-complexity or coding task' };
      return { model: 'gpt-5.4', reason: 'General or simple task' };
    }

    case 'claude': {
      if (isSimple) return { model: 'sonnet', reason: 'Simple task' };
      return { model: 'opus', reason: 'Medium or High-complexity task' };
    }

    case 'gemini': {
      return { model: '3.1 Pro Preview', reason: 'Always use highest-end model' };
    }

    case 'deepseek': {
      return { model: 'DeepSeek-R1', reason: 'High-end reasoning model' };
    }

    case 'grok': {
      return { model: 'grok-3', reason: 'Always use highest-end model' };
    }

    case 'mistral': {
      return { model: 'Mistral Large', reason: 'Always use highest-end model' };
    }

    case 'poe': {
      if (isSimple) return { model: 'Claude-3.5-Sonnet', reason: 'Simple task' };
      return { model: 'Claude-3.5-Opus', reason: 'Medium or High-complexity task' };
    }

    case 'qwen': {
      return { model: 'Qwen-Max', reason: 'Always use highest-end model' };
    }

    case 'huggingchat': {
      return { model: 'Qwen/QwQ-32B', reason: 'Always use highest-end model' };
    }

    case 'copilot': {
      return { model: 'GPT-4.5', reason: 'Copilot using latest high-end model' };
    }

    case 'perplexity': {
      return { model: 'sonar-pro', reason: 'Perplexity high-end model' };
    }

    default: {
      return { model: 'default', reason: `Unknown provider: ${provider}` };
    }
  }
}

/**
 * High-level function: analyze state and return optimal model selection for a turn.
 * @param {object} state - Deliberation state with topic, log, speaker_roles
 * @param {string} speaker - The current speaker identifier
 * @param {string} provider - The AI provider to use
 * @returns {{ model: string, category: string, complexity: string, reason: string }}
 */
export function getModelSelectionForTurn(state, speaker, provider) {
  const topic = state.topic || '';
  const role = (state.speaker_roles && state.speaker_roles[speaker]) || '';

  // Use recent log entries (last 5) for context analysis
  const recentEntries = Array.isArray(state.log) ? state.log.slice(-5) : [];
  const recentLog = recentEntries
    .map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    .join(' ');

  const { category, complexity } = analyzePromptContext(topic, recentLog, role);
  const { model, reason } = selectModelForProvider(provider, category, complexity);

  return { model, category, complexity, reason };
}

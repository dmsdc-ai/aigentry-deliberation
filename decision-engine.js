/**
 * Decision Engine — Stage-based state machine for structured multi-AI decision making.
 *
 * Implements a pipeline: intake → parallel_opinions → conflict_map → user_probe → synthesis → action_export → done
 *
 * Each stage enforces strict transitions. Multiple LLMs give independent parallel opinions,
 * conflicts are mapped via MCDA score divergence, and the user resolves them before synthesis.
 *
 * Pure ESM, no external dependencies (Node.js built-in only: fs, path, crypto).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Constants ────────────────────────────────────────────────────

/**
 * Ordered stages of a decision session.
 * @type {readonly string[]}
 */
export const DECISION_STAGES = [
  "intake",            // Problem definition, options, criteria collection
  "parallel_opinions", // All LLMs give independent opinions (no cross-visibility)
  "conflict_map",      // Extract disagreements between opinions
  "user_probe",        // Present conflicts to user, pause for input
  "synthesis",         // Combine user input + opinions into final decision
  "action_export",     // Convert decision to actionable output
  "done",
];

/**
 * Valid stage transitions. Each key maps to the single allowed next stage.
 * @type {Record<string, string>}
 */
export const STAGE_TRANSITIONS = {
  intake: "parallel_opinions",
  parallel_opinions: "conflict_map",
  conflict_map: "user_probe",
  user_probe: "synthesis",
  synthesis: "action_export",
  action_export: "done",
};

/** Score divergence threshold to flag a criterion as a conflict (1-10 scale). */
const CONFLICT_DIVERGENCE_THRESHOLD = 3;

/** Maximum number of conflicts surfaced to the user to avoid overwhelm. */
const MAX_CONFLICTS = 5;

// ── Helpers ──────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a slug from text: lowercase, strip non-alphanumeric, collapse dashes, truncate.
 * @param {string} text
 * @param {number} [maxLen=48]
 * @returns {string}
 */
function slugify(text, maxLen = 48) {
  return (text || "decision")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen) || "decision";
}

/**
 * ISO timestamp string.
 * @returns {string}
 */
function now() {
  return new Date().toISOString();
}

// ── Core API ─────────────────────────────────────────────────────

/**
 * @typedef {Object} ModelOpinion
 * @property {string} speaker       - LLM identifier
 * @property {string} summary       - 1-line conclusion
 * @property {string} reasoning     - Full reasoning text
 * @property {Record<string, number>} scores - MCDA scores per criterion (1-10)
 * @property {string} recommendation - Which option the model recommends
 * @property {number} confidence    - 0-1 confidence value
 * @property {string} timestamp     - ISO timestamp
 */

/**
 * @typedef {Object} ConflictItem
 * @property {string} id            - conflict-{index}
 * @property {string} criterion     - Which criterion the conflict is about
 * @property {Record<string, string>} positions - speaker -> their position text
 * @property {Record<string, number>} scores    - speaker -> their score
 * @property {number} divergence    - Score spread (max - min)
 * @property {string} question      - Auto-generated clarifying question for user
 */

/**
 * @typedef {Object} ActionPlan
 * @property {string} decision      - The final decision
 * @property {string} rationale     - Why this decision was made
 * @property {Array<{id: string, title: string, description: string, priority: string}>} actionItems
 * @property {Array<{description: string, mitigation: string, probability: string}>} risks
 * @property {{checklist: string, githubIssue: string}} exportFormats
 */

/**
 * @typedef {Object} DecisionSession
 * @property {string} id
 * @property {"decision"} type
 * @property {string} stage
 * @property {"active"|"completed"|"cancelled"} status
 * @property {string} problem
 * @property {string[]} options
 * @property {string[]} criteria
 * @property {string|null} template
 * @property {string[]} speakers
 * @property {Array} participant_profiles
 * @property {Record<string, ModelOpinion>} opinions
 * @property {ConflictItem[]} conflicts
 * @property {Array} userProbeResponses
 * @property {string|null} synthesis
 * @property {ActionPlan|null} actionPlan
 * @property {Array} log
 * @property {{created: string, updated: string, participants: number, template: string|null}} metadata
 */

/**
 * Create a new decision session.
 *
 * @param {Object} params
 * @param {string} params.problem      - The decision question
 * @param {string[]} [params.options]  - Available choices (can be empty)
 * @param {string[]} [params.criteria] - Evaluation criteria
 * @param {string[]} params.speakers   - Participating LLMs
 * @param {string|null} [params.template] - Template name if used
 * @param {Array} [params.participant_profiles] - Same format as deliberation
 * @returns {DecisionSession}
 */
export function createDecisionSession({
  problem,
  options = [],
  criteria = [],
  speakers = [],
  template = null,
  participant_profiles = [],
}) {
  if (!problem || typeof problem !== "string") {
    throw new Error("problem is required and must be a non-empty string");
  }
  if (!Array.isArray(speakers) || speakers.length === 0) {
    throw new Error("speakers must be a non-empty array");
  }

  const id = `decision-${slugify(problem)}-${randomUUID().slice(0, 8)}`;
  const timestamp = now();

  return {
    id,
    type: "decision",
    stage: "intake",
    status: "active",
    problem,
    options: Array.isArray(options) ? [...options] : [],
    criteria: Array.isArray(criteria) ? [...criteria] : [],
    template: template || null,
    speakers: [...speakers],
    participant_profiles: Array.isArray(participant_profiles) ? [...participant_profiles] : [],
    opinions: {},
    conflicts: [],
    userProbeResponses: [],
    synthesis: null,
    actionPlan: null,
    log: [],
    metadata: {
      created: timestamp,
      updated: timestamp,
      participants: speakers.length,
      template: template || null,
    },
  };
}

/**
 * Advance a decision session to the next stage.
 *
 * Validates the current stage has a valid transition, updates the session in place,
 * appends a log entry, and returns the session.
 *
 * @param {DecisionSession} session
 * @returns {DecisionSession} The updated session
 * @throws {Error} If current stage has no valid transition or session is not active
 */
export function advanceStage(session) {
  if (!session || typeof session !== "object") {
    throw new Error("session is required");
  }
  if (session.status !== "active") {
    throw new Error(`Cannot advance: session status is "${session.status}", expected "active"`);
  }

  const nextStage = STAGE_TRANSITIONS[session.stage];
  if (!nextStage) {
    throw new Error(`No valid transition from stage "${session.stage}"`);
  }

  const prevStage = session.stage;
  session.stage = nextStage;
  session.metadata.updated = now();

  if (nextStage === "done") {
    session.status = "completed";
  }

  session.log.push({
    event: "stage_transition",
    from: prevStage,
    to: nextStage,
    timestamp: now(),
  });

  return session;
}

/**
 * Build a conflict map from model opinions and evaluation criteria.
 *
 * For each criterion, collects scores from all opinions, calculates divergence,
 * and flags criteria with divergence >= CONFLICT_DIVERGENCE_THRESHOLD as conflicts.
 * Returns top MAX_CONFLICTS conflicts sorted by divergence descending.
 *
 * @param {Record<string, ModelOpinion>} opinions - speaker -> opinion
 * @param {string[]} criteria - List of evaluation criteria
 * @returns {ConflictItem[]}
 */
export function buildConflictMap(opinions, criteria) {
  if (!opinions || typeof opinions !== "object") return [];
  if (!Array.isArray(criteria) || criteria.length === 0) return [];

  const speakerNames = Object.keys(opinions);
  if (speakerNames.length < 2) return [];

  const conflicts = [];

  for (const criterion of criteria) {
    const scores = {};
    const positions = {};
    let hasScores = false;

    for (const speaker of speakerNames) {
      const opinion = opinions[speaker];
      if (!opinion) continue;

      // Collect score for this criterion
      const score = opinion.scores?.[criterion];
      if (typeof score === "number" && score >= 1 && score <= 10) {
        scores[speaker] = score;
        hasScores = true;
      }

      // Extract position text: use reasoning or summary as fallback
      positions[speaker] = extractPositionForCriterion(opinion, criterion);
    }

    if (!hasScores) continue;

    const scoreValues = Object.values(scores);
    if (scoreValues.length < 2) continue;

    const maxScore = Math.max(...scoreValues);
    const minScore = Math.min(...scoreValues);
    const divergence = maxScore - minScore;

    if (divergence >= CONFLICT_DIVERGENCE_THRESHOLD) {
      // Find the speakers at max and min for the question
      const maxSpeaker = speakerNames.find(s => scores[s] === maxScore) || speakerNames[0];
      const minSpeaker = speakerNames.find(s => scores[s] === minScore) || speakerNames[1];

      const question =
        `Models disagree on "${criterion}": ` +
        `${maxSpeaker} says "${truncate(positions[maxSpeaker], 80)}" (score: ${scores[maxSpeaker]}), ` +
        `${minSpeaker} says "${truncate(positions[minSpeaker], 80)}" (score: ${scores[minSpeaker]}). ` +
        `Which perspective aligns more with your priorities?`;

      conflicts.push({
        id: `conflict-${conflicts.length}`,
        criterion,
        positions,
        scores,
        divergence,
        question,
      });
    }
  }

  // Sort by divergence descending, cap at MAX_CONFLICTS
  conflicts.sort((a, b) => b.divergence - a.divergence);
  const topConflicts = conflicts.slice(0, MAX_CONFLICTS);

  // Re-index IDs after sorting/slicing
  for (let i = 0; i < topConflicts.length; i++) {
    topConflicts[i].id = `conflict-${i}`;
  }

  return topConflicts;
}

/**
 * Extract a speaker's position text for a given criterion from their opinion.
 * Searches reasoning for a sentence mentioning the criterion, falls back to summary.
 *
 * @param {ModelOpinion} opinion
 * @param {string} criterion
 * @returns {string}
 */
function extractPositionForCriterion(opinion, criterion) {
  if (!opinion) return "(no opinion)";

  const reasoning = opinion.reasoning || "";
  const criterionLower = criterion.toLowerCase();

  // Try to find a sentence in reasoning that mentions the criterion
  const sentences = reasoning.split(/[.!?]\s+/);
  for (const sentence of sentences) {
    if (sentence.toLowerCase().includes(criterionLower)) {
      return sentence.trim();
    }
  }

  // Fall back to summary
  return opinion.summary || opinion.recommendation || "(no position stated)";
}

/**
 * Truncate text to maxLen, appending "..." if truncated.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(text, maxLen) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Parse a raw LLM response into a structured ModelOpinion.
 *
 * Handles both structured (markdown headers + score lines) and unstructured responses.
 * Looks for "## Summary", "## Recommendation", score patterns "Criterion: N/10", confidence "Confidence: X%".
 *
 * @param {string} speaker  - Speaker identifier
 * @param {string} content  - Raw LLM response text
 * @param {string[]} criteria - Expected criteria list
 * @returns {ModelOpinion}
 */
export function parseOpinionFromResponse(speaker, content, criteria) {
  if (!content || typeof content !== "string") {
    return {
      speaker,
      summary: "(empty response)",
      reasoning: "",
      scores: {},
      recommendation: "",
      confidence: 0.5,
      timestamp: now(),
    };
  }

  const lines = content.split("\n");

  // Extract sections by markdown headers
  const sections = {};
  let currentSection = "__preamble";
  const sectionLines = { __preamble: [] };

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim().toLowerCase();
      sectionLines[currentSection] = [];
    } else {
      if (!sectionLines[currentSection]) sectionLines[currentSection] = [];
      sectionLines[currentSection].push(line);
    }
  }

  for (const [key, value] of Object.entries(sectionLines)) {
    sections[key] = value.join("\n").trim();
  }

  // Extract summary
  const summary =
    sections["summary"] ||
    sections["recommendation"] ||
    sections["conclusion"] ||
    extractFirstNonEmpty(lines, 120);

  // Extract recommendation
  const recommendation =
    sections["recommendation"] ||
    sections["decision"] ||
    sections["conclusion"] ||
    "";

  // Extract reasoning
  const reasoning =
    sections["reasoning"] ||
    sections["analysis"] ||
    sections["rationale"] ||
    content;

  // Extract scores per criterion
  const scores = {};
  if (Array.isArray(criteria)) {
    for (const criterion of criteria) {
      const score = extractScoreForCriterion(content, criterion);
      if (score !== null) {
        scores[criterion] = score;
      }
    }
  }

  // Extract confidence
  const confidence = extractConfidence(content);

  return {
    speaker,
    summary: truncate(summary, 200),
    reasoning,
    scores,
    recommendation: truncate(recommendation, 200),
    confidence,
    timestamp: now(),
  };
}

/**
 * Extract a numeric score (1-10) for a given criterion from text.
 * Handles patterns: "Criterion: N/10", "Criterion: N", "- Criterion — N/10", etc.
 *
 * @param {string} text
 * @param {string} criterion
 * @returns {number|null}
 */
function extractScoreForCriterion(text, criterion) {
  if (!text || !criterion) return null;

  // Escape special regex chars in criterion name
  const escaped = criterion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Pattern variants:
  //   Criterion: 8/10
  //   Criterion: 8
  //   - Criterion — 8/10
  //   **Criterion**: 8
  //   | Criterion | 8 |
  const patterns = [
    new RegExp(`(?:^|[\\-*|])\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[:—|]\\s*(\\d{1,2})(?:\\/10)?`, "im"),
    new RegExp(`${escaped}[^\\d]{0,20}(\\d{1,2})(?:\\/10|\\s*(?:out of|of)\\s*10)?`, "im"),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= 10) return num;
    }
  }

  return null;
}

/**
 * Extract confidence value (0-1) from text.
 * Handles: "Confidence: 85%", "Confidence: 0.85", "confidence level: high"
 *
 * @param {string} text
 * @returns {number}
 */
function extractConfidence(text) {
  if (!text) return 0.5;

  // Percentage pattern: "Confidence: 85%" or "confidence level: 85%"
  const pctMatch = text.match(/confidence[^:]*:\s*(\d{1,3})\s*%/i);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10);
    if (pct >= 0 && pct <= 100) return pct / 100;
  }

  // Decimal pattern: "Confidence: 0.85"
  const decMatch = text.match(/confidence[^:]*:\s*(0?\.\d+|1\.0?)/i);
  if (decMatch) {
    const val = parseFloat(decMatch[1]);
    if (val >= 0 && val <= 1) return val;
  }

  // Keyword pattern
  const lower = text.toLowerCase();
  if (/confidence[^.]*\b(very\s+high|extremely\s+high)\b/i.test(lower)) return 0.95;
  if (/confidence[^.]*\bhigh\b/i.test(lower)) return 0.85;
  if (/confidence[^.]*\bmedium\b/i.test(lower)) return 0.65;
  if (/confidence[^.]*\blow\b/i.test(lower)) return 0.35;
  if (/confidence[^.]*\bvery\s+low\b/i.test(lower)) return 0.15;

  return 0.5; // default mid-confidence
}

/**
 * Return the first non-empty, non-header line from an array, truncated.
 * @param {string[]} lines
 * @param {number} maxLen
 * @returns {string}
 */
function extractFirstNonEmpty(lines, maxLen) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return truncate(trimmed, maxLen);
    }
  }
  return "";
}

/**
 * Build the prompt sent to each LLM for independent opinion extraction.
 *
 * The prompt clearly states the problem, lists options and criteria,
 * and requests a structured response. Does NOT include any other model's opinion.
 *
 * @param {string} problem   - The decision question
 * @param {string[]} options - Available choices
 * @param {string[]} criteria - Evaluation criteria
 * @param {string|null} [template] - Template name (for context)
 * @returns {string}
 */
export function buildOpinionPrompt(problem, options, criteria, template = null) {
  const parts = [];

  parts.push("You are participating in a structured decision-making process.");
  parts.push("Give your INDEPENDENT opinion. Do NOT reference other models or prior opinions.\n");

  parts.push(`## Decision Problem\n${problem}\n`);

  if (Array.isArray(options) && options.length > 0) {
    parts.push("## Available Options");
    for (let i = 0; i < options.length; i++) {
      parts.push(`${i + 1}. ${options[i]}`);
    }
    parts.push("");
  }

  if (Array.isArray(criteria) && criteria.length > 0) {
    parts.push("## Evaluation Criteria");
    parts.push("Score each criterion from 1 (worst) to 10 (best) for your recommended option.\n");
    for (const c of criteria) {
      parts.push(`- ${c}`);
    }
    parts.push("");
  }

  if (template) {
    parts.push(`*Using decision template: ${template}*\n`);
  }

  parts.push("## Required Response Format\n");
  parts.push("Please structure your response with these sections:\n");
  parts.push("### Summary");
  parts.push("(1-2 sentence conclusion)\n");
  parts.push("### Recommendation");
  parts.push("(Which option you recommend and why)\n");

  if (Array.isArray(criteria) && criteria.length > 0) {
    parts.push("### Scores");
    for (const c of criteria) {
      parts.push(`- ${c}: ?/10`);
    }
    parts.push("");
  }

  parts.push("### Reasoning");
  parts.push("(Detailed analysis supporting your recommendation)\n");
  parts.push("### Confidence");
  parts.push("(Your confidence level as a percentage, e.g., Confidence: 80%)");

  return parts.join("\n");
}

/**
 * Generate formatted markdown presenting conflicts to the user with numbered questions.
 *
 * @param {ConflictItem[]} conflicts
 * @returns {string}
 */
export function generateConflictQuestions(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    return "No significant conflicts detected between model opinions. Proceeding to synthesis.";
  }

  const parts = [];
  parts.push("# Decision Conflicts Requiring Your Input\n");
  parts.push(`The participating models disagree on **${conflicts.length}** key area${conflicts.length > 1 ? "s" : ""}.\n`);
  parts.push("Please review each conflict and share your perspective:\n");
  parts.push("---\n");

  for (let i = 0; i < conflicts.length; i++) {
    const c = conflicts[i];
    parts.push(`## Conflict ${i + 1}: ${c.criterion}`);
    parts.push(`**Divergence score:** ${c.divergence}/10\n`);

    // Show each speaker's position and score
    const speakers = Object.keys(c.scores);
    for (const speaker of speakers) {
      const score = c.scores[speaker];
      const position = c.positions?.[speaker] || "(no position)";
      parts.push(`- **${speaker}** (score: ${score}/10): ${truncate(position, 150)}`);
    }

    parts.push("");
    parts.push(`**Question ${i + 1}:** ${c.question}\n`);
    parts.push("---\n");
  }

  parts.push("Please respond with your preference for each numbered question.");

  return parts.join("\n");
}

/**
 * Build a synthesis report from a complete decision session.
 *
 * Combines opinions, conflicts, and user probe responses into
 * an executive summary, criteria breakdown, and conflict resolution summary.
 *
 * @param {DecisionSession} session
 * @returns {string} Markdown synthesis report
 */
export function buildSynthesis(session) {
  if (!session || typeof session !== "object") {
    return "Error: invalid session";
  }

  const parts = [];
  const opinions = session.opinions || {};
  const conflicts = session.conflicts || [];
  const userResponses = session.userProbeResponses || [];
  const speakerNames = Object.keys(opinions);

  // ── Executive Summary ──
  parts.push("# Decision Synthesis Report\n");
  parts.push(`**Problem:** ${session.problem}\n`);

  // Determine consensus recommendation
  const recommendationCounts = {};
  for (const opinion of Object.values(opinions)) {
    const rec = opinion.recommendation || "(none)";
    recommendationCounts[rec] = (recommendationCounts[rec] || 0) + 1;
  }
  const sortedRecs = Object.entries(recommendationCounts).sort((a, b) => b[1] - a[1]);
  const topRec = sortedRecs[0];

  if (topRec) {
    const unanimity = topRec[1] === speakerNames.length ? "unanimous" : `${topRec[1]}/${speakerNames.length}`;
    parts.push(`**Consensus recommendation:** ${topRec[0]} (${unanimity} agreement)\n`);
  }

  // Average confidence
  const confidences = Object.values(opinions).map(o => o.confidence).filter(c => typeof c === "number");
  if (confidences.length > 0) {
    const avgConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    parts.push(`**Average confidence:** ${Math.round(avgConf * 100)}%\n`);
  }

  // ── Individual Summaries ──
  parts.push("## Model Opinions\n");
  for (const speaker of speakerNames) {
    const op = opinions[speaker];
    parts.push(`### ${speaker}`);
    parts.push(`- **Recommendation:** ${op.recommendation || "(none)"}`);
    parts.push(`- **Summary:** ${op.summary || "(none)"}`);
    parts.push(`- **Confidence:** ${Math.round((op.confidence || 0.5) * 100)}%`);
    parts.push("");
  }

  // ── Criteria Breakdown Table ──
  if (Array.isArray(session.criteria) && session.criteria.length > 0 && speakerNames.length > 0) {
    parts.push("## Criteria Scores\n");

    // Table header
    const header = `| Criterion | ${speakerNames.join(" | ")} | Avg |`;
    const separator = `|${"-".repeat(11)}|${speakerNames.map(() => "-".repeat(7)).join("|")}|${"-".repeat(6)}|`;
    parts.push(header);
    parts.push(separator);

    for (const criterion of session.criteria) {
      const scores = speakerNames.map(s => opinions[s]?.scores?.[criterion]);
      const validScores = scores.filter(s => typeof s === "number");
      const avg = validScores.length > 0
        ? (validScores.reduce((a, b) => a + b, 0) / validScores.length).toFixed(1)
        : "—";
      const row = `| ${truncate(criterion, 30)} | ${scores.map(s => (typeof s === "number" ? String(s) : "—")).join(" | ")} | ${avg} |`;
      parts.push(row);
    }
    parts.push("");
  }

  // ── Conflict Resolution ──
  if (conflicts.length > 0) {
    parts.push("## Conflict Resolution\n");
    for (let i = 0; i < conflicts.length; i++) {
      const c = conflicts[i];
      const userResponse = userResponses[i] || "(no response)";
      parts.push(`### ${c.criterion} (divergence: ${c.divergence})`);
      parts.push(`- **User's resolution:** ${userResponse}`);
      parts.push("");
    }
  } else {
    parts.push("## Conflicts\n");
    parts.push("No significant conflicts were detected.\n");
  }

  return parts.join("\n");
}

/**
 * Convert a decision session's synthesis into an actionable plan.
 *
 * @param {DecisionSession} session
 * @returns {ActionPlan}
 */
export function buildActionPlan(session) {
  if (!session || typeof session !== "object") {
    return {
      decision: "(no session)",
      rationale: "",
      actionItems: [],
      risks: [],
      exportFormats: { checklist: "", githubIssue: "" },
    };
  }

  const opinions = session.opinions || {};
  const speakerNames = Object.keys(opinions);

  // Determine the winning recommendation
  const recommendationCounts = {};
  for (const opinion of Object.values(opinions)) {
    const rec = opinion.recommendation || "";
    if (rec) recommendationCounts[rec] = (recommendationCounts[rec] || 0) + 1;
  }
  const sortedRecs = Object.entries(recommendationCounts).sort((a, b) => b[1] - a[1]);
  const decision = sortedRecs[0]?.[0] || session.problem;

  // Build rationale from consensus + user input
  const rationale = buildRationale(session, decision);

  // Generate action items from the decision and criteria
  const actionItems = generateActionItems(session, decision);

  // Generate risks from low-scored criteria and conflicts
  const risks = generateRisks(session);

  // Export formats
  const checklist = buildChecklist(decision, actionItems);
  const githubIssue = buildGithubIssue(session, decision, rationale, actionItems, risks);

  return {
    decision,
    rationale,
    actionItems,
    risks,
    exportFormats: {
      checklist,
      githubIssue,
    },
  };
}

/**
 * Build rationale text from session data.
 * @param {DecisionSession} session
 * @param {string} decision
 * @returns {string}
 */
function buildRationale(session, decision) {
  const parts = [];
  const opinions = session.opinions || {};
  const speakerNames = Object.keys(opinions);

  // Count agreement
  const agreeing = speakerNames.filter(s => {
    const rec = opinions[s]?.recommendation || "";
    return rec.toLowerCase().includes(decision.toLowerCase().slice(0, 20));
  });

  if (agreeing.length > 0) {
    parts.push(`${agreeing.length}/${speakerNames.length} models recommended this approach.`);
  }

  // User resolutions
  if (session.userProbeResponses && session.userProbeResponses.length > 0) {
    parts.push("User input was incorporated for conflict resolution.");
  }

  // Average confidence
  const confidences = Object.values(opinions).map(o => o.confidence).filter(c => typeof c === "number");
  if (confidences.length > 0) {
    const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    parts.push(`Average model confidence: ${Math.round(avg * 100)}%.`);
  }

  return parts.join(" ") || "Decision based on multi-model deliberation.";
}

/**
 * Generate action items from session data.
 * @param {DecisionSession} session
 * @param {string} decision
 * @returns {Array<{id: string, title: string, description: string, priority: string}>}
 */
function generateActionItems(session, decision) {
  const items = [];

  // Primary action: implement the decision
  items.push({
    id: "action-0",
    title: `Implement: ${truncate(decision, 60)}`,
    description: `Execute the decided approach: ${decision}`,
    priority: "high",
  });

  // For each criterion, create a monitoring/validation action
  const criteria = session.criteria || [];
  for (let i = 0; i < criteria.length && i < 5; i++) {
    items.push({
      id: `action-${i + 1}`,
      title: `Validate: ${truncate(criteria[i], 60)}`,
      description: `Ensure the implementation satisfies the "${criteria[i]}" criterion`,
      priority: i < 2 ? "medium" : "low",
    });
  }

  return items;
}

/**
 * Generate risk items from low scores and conflicts.
 * @param {DecisionSession} session
 * @returns {Array<{description: string, mitigation: string, probability: string}>}
 */
function generateRisks(session) {
  const risks = [];
  const opinions = session.opinions || {};
  const conflicts = session.conflicts || [];
  const criteria = session.criteria || [];

  // Risks from high-divergence conflicts
  for (const conflict of conflicts) {
    risks.push({
      description: `Disagreement on "${conflict.criterion}" (divergence: ${conflict.divergence}/10)`,
      mitigation: `Monitor and re-evaluate if assumptions about "${conflict.criterion}" change`,
      probability: conflict.divergence >= 6 ? "high" : "medium",
    });
  }

  // Risks from criteria with low average scores
  for (const criterion of criteria) {
    const scores = Object.values(opinions)
      .map(o => o.scores?.[criterion])
      .filter(s => typeof s === "number");
    if (scores.length === 0) continue;

    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg <= 4) {
      risks.push({
        description: `Low confidence in "${criterion}" (avg score: ${avg.toFixed(1)}/10)`,
        mitigation: `Investigate alternatives or mitigations for "${criterion}"`,
        probability: avg <= 2 ? "high" : "medium",
      });
    }
  }

  return risks.slice(0, 8); // Cap at 8 risks
}

/**
 * Build a markdown checklist from action items.
 * @param {string} decision
 * @param {Array<{id: string, title: string, description: string, priority: string}>} actionItems
 * @returns {string}
 */
function buildChecklist(decision, actionItems) {
  const parts = [];
  parts.push(`# Decision Checklist: ${truncate(decision, 60)}\n`);
  for (const item of actionItems) {
    const priorityTag = item.priority === "high" ? " [HIGH]" : item.priority === "medium" ? " [MED]" : "";
    parts.push(`- [ ]${priorityTag} ${item.title}`);
    if (item.description) {
      parts.push(`  - ${item.description}`);
    }
  }
  return parts.join("\n");
}

/**
 * Build a GitHub issue body from session data.
 * @param {DecisionSession} session
 * @param {string} decision
 * @param {string} rationale
 * @param {Array} actionItems
 * @param {Array} risks
 * @returns {string}
 */
function buildGithubIssue(session, decision, rationale, actionItems, risks) {
  const parts = [];

  parts.push(`## Decision: ${decision}\n`);
  parts.push(`**Problem:** ${session.problem}\n`);
  parts.push(`**Rationale:** ${rationale}\n`);

  if (actionItems.length > 0) {
    parts.push("### Action Items\n");
    for (const item of actionItems) {
      parts.push(`- [ ] **[${item.priority.toUpperCase()}]** ${item.title}: ${item.description}`);
    }
    parts.push("");
  }

  if (risks.length > 0) {
    parts.push("### Risks\n");
    for (const risk of risks) {
      parts.push(`- **[${risk.probability.toUpperCase()}]** ${risk.description}`);
      parts.push(`  - Mitigation: ${risk.mitigation}`);
    }
    parts.push("");
  }

  parts.push("---");
  parts.push(`*Generated by aigentry-deliberation decision engine*`);

  return parts.join("\n");
}

/**
 * Load decision templates from the selectors directory.
 * Returns an empty array if the file does not exist or is invalid.
 *
 * @returns {Array<{name: string, description: string, criteria: string[], options?: string[], keywords?: string[]}>}
 */
export function loadTemplates() {
  const templatePath = join(__dirname, "selectors", "decision-templates.json");
  try {
    const raw = readFileSync(templatePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Match a template to a problem description using keyword matching.
 *
 * Scores each template by counting keyword hits in the problem text.
 * Returns the best-matching template, or null if no template matches.
 *
 * @param {string} problemText - The decision problem description
 * @param {Array<{name: string, keywords?: string[], description?: string}>} templates
 * @returns {{name: string, description: string, criteria: string[], options?: string[], keywords?: string[]}|null}
 */
export function matchTemplate(problemText, templates) {
  if (!problemText || !Array.isArray(templates) || templates.length === 0) {
    return null;
  }

  const lower = problemText.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const template of templates) {
    let score = 0;
    const keywords = template.keywords || [];

    for (const keyword of keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        score++;
      }
    }

    // Also match against template name and description
    if (template.name && lower.includes(template.name.toLowerCase())) {
      score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  // Require at least 1 keyword match
  return bestScore >= 1 ? bestMatch : null;
}

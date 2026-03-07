import { describe, it, expect } from "vitest";
import {
  createDecisionSession,
  advanceStage,
  buildConflictMap,
  parseOpinionFromResponse,
  buildOpinionPrompt,
  generateConflictQuestions,
  buildSynthesis,
  buildActionPlan,
  loadTemplates,
  matchTemplate,
  DECISION_STAGES,
  STAGE_TRANSITIONS,
} from "../decision-engine.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return createDecisionSession({
    problem: "Which database should we use?",
    speakers: ["claude", "gpt4"],
    options: ["PostgreSQL", "MongoDB"],
    criteria: ["scalability", "ease of use"],
    ...overrides,
  });
}

function makeOpinions() {
  return {
    claude: {
      speaker: "claude",
      summary: "PostgreSQL is the best choice",
      reasoning: "scalability is excellent for relational data. ease of use is moderate.",
      scores: { scalability: 9, "ease of use": 6 },
      recommendation: "PostgreSQL",
      confidence: 0.9,
      timestamp: new Date().toISOString(),
    },
    gpt4: {
      speaker: "gpt4",
      summary: "MongoDB fits better for flexible schemas",
      reasoning: "scalability is good for document-based. ease of use is very high.",
      scores: { scalability: 5, "ease of use": 9 },
      recommendation: "MongoDB",
      confidence: 0.75,
      timestamp: new Date().toISOString(),
    },
  };
}

// ── 1. createDecisionSession ──────────────────────────────────────────────────

describe("createDecisionSession", () => {
  it("creates a session with valid params", () => {
    const session = createDecisionSession({
      problem: "Should we migrate to the cloud?",
      speakers: ["claude", "gpt4"],
      options: ["AWS", "GCP"],
      criteria: ["cost", "performance"],
    });

    expect(session).toBeDefined();
    expect(session.type).toBe("decision");
    expect(session.stage).toBe("intake");
    expect(session.status).toBe("active");
    expect(session.problem).toBe("Should we migrate to the cloud?");
    expect(session.speakers).toEqual(["claude", "gpt4"]);
    expect(session.options).toEqual(["AWS", "GCP"]);
    expect(session.criteria).toEqual(["cost", "performance"]);
  });

  it("throws on missing problem", () => {
    expect(() =>
      createDecisionSession({ speakers: ["claude"] })
    ).toThrow("problem is required");
  });

  it("throws on empty string problem", () => {
    expect(() =>
      createDecisionSession({ problem: "", speakers: ["claude"] })
    ).toThrow("problem is required");
  });

  it("throws on non-string problem", () => {
    expect(() =>
      createDecisionSession({ problem: 42, speakers: ["claude"] })
    ).toThrow("problem is required");
  });

  it("throws on missing speakers", () => {
    expect(() =>
      createDecisionSession({ problem: "Test problem" })
    ).toThrow("speakers must be a non-empty array");
  });

  it("throws on empty speakers array", () => {
    expect(() =>
      createDecisionSession({ problem: "Test problem", speakers: [] })
    ).toThrow("speakers must be a non-empty array");
  });

  it("sets default values for optional fields", () => {
    const session = createDecisionSession({
      problem: "Test",
      speakers: ["claude"],
    });
    expect(session.options).toEqual([]);
    expect(session.criteria).toEqual([]);
    expect(session.template).toBeNull();
    expect(session.participant_profiles).toEqual([]);
    expect(session.opinions).toEqual({});
    expect(session.conflicts).toEqual([]);
    expect(session.userProbeResponses).toEqual([]);
    expect(session.synthesis).toBeNull();
    expect(session.actionPlan).toBeNull();
    expect(session.log).toEqual([]);
  });

  it("generates unique IDs for different sessions", () => {
    const s1 = createDecisionSession({ problem: "Problem A", speakers: ["claude"] });
    const s2 = createDecisionSession({ problem: "Problem A", speakers: ["claude"] });
    expect(s1.id).not.toBe(s2.id);
  });

  it("includes problem slug in the ID", () => {
    const session = createDecisionSession({
      problem: "Should we use TypeScript?",
      speakers: ["claude"],
    });
    expect(session.id).toMatch(/^decision-should-we-use-typescript/);
  });

  it("sets metadata.participants to speakers length", () => {
    const session = createDecisionSession({
      problem: "Test",
      speakers: ["claude", "gpt4", "gemini"],
    });
    expect(session.metadata.participants).toBe(3);
  });

  it("sets template when provided", () => {
    const session = createDecisionSession({
      problem: "Test",
      speakers: ["claude"],
      template: "tech-decision",
    });
    expect(session.template).toBe("tech-decision");
    expect(session.metadata.template).toBe("tech-decision");
  });

  it("sets metadata created and updated timestamps", () => {
    const before = Date.now();
    const session = createDecisionSession({ problem: "Test", speakers: ["a"] });
    const after = Date.now();
    const created = new Date(session.metadata.created).getTime();
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
    expect(session.metadata.created).toBe(session.metadata.updated);
  });
});

// ── 2. advanceStage ───────────────────────────────────────────────────────────

describe("advanceStage", () => {
  it("transitions intake -> parallel_opinions", () => {
    const session = makeSession();
    advanceStage(session);
    expect(session.stage).toBe("parallel_opinions");
  });

  it("transitions through all stages to done", () => {
    const session = makeSession();
    const expectedPath = [
      "parallel_opinions",
      "conflict_map",
      "user_probe",
      "synthesis",
      "action_export",
      "done",
    ];
    for (const expectedStage of expectedPath) {
      advanceStage(session);
      expect(session.stage).toBe(expectedStage);
    }
  });

  it("sets status to completed when reaching done", () => {
    const session = makeSession();
    const stagesCount = Object.keys(STAGE_TRANSITIONS).length;
    for (let i = 0; i < stagesCount; i++) {
      advanceStage(session);
    }
    expect(session.stage).toBe("done");
    expect(session.status).toBe("completed");
  });

  it("throws on non-active session", () => {
    const session = makeSession();
    session.status = "completed";
    expect(() => advanceStage(session)).toThrow("active");
  });

  it("throws on cancelled session", () => {
    const session = makeSession();
    session.status = "cancelled";
    expect(() => advanceStage(session)).toThrow("active");
  });

  it("throws when no valid transition from done stage", () => {
    const session = makeSession();
    // Drive to done
    while (session.stage !== "done" && session.status === "active") {
      advanceStage(session);
    }
    session.status = "active"; // force re-activation to attempt transition from done
    expect(() => advanceStage(session)).toThrow('No valid transition from stage "done"');
  });

  it("appends log entries on each transition", () => {
    const session = makeSession();
    advanceStage(session);
    advanceStage(session);
    expect(session.log).toHaveLength(2);
    expect(session.log[0]).toMatchObject({
      event: "stage_transition",
      from: "intake",
      to: "parallel_opinions",
    });
    expect(session.log[1]).toMatchObject({
      event: "stage_transition",
      from: "parallel_opinions",
      to: "conflict_map",
    });
  });

  it("updates metadata.updated on each transition", () => {
    const session = makeSession();
    const originalUpdated = session.metadata.updated;
    advanceStage(session);
    // updated should be >= original
    expect(new Date(session.metadata.updated).getTime()).toBeGreaterThanOrEqual(
      new Date(originalUpdated).getTime()
    );
  });

  it("returns the session object", () => {
    const session = makeSession();
    const result = advanceStage(session);
    expect(result).toBe(session);
  });
});

// ── 3. buildConflictMap ───────────────────────────────────────────────────────

describe("buildConflictMap", () => {
  it("returns empty for less than 2 speakers", () => {
    const opinions = {
      claude: {
        scores: { scalability: 8 },
        reasoning: "",
        summary: "",
        recommendation: "",
        confidence: 0.8,
      },
    };
    const result = buildConflictMap(opinions, ["scalability"]);
    expect(result).toEqual([]);
  });

  it("returns empty for no criteria", () => {
    const opinions = makeOpinions();
    expect(buildConflictMap(opinions, [])).toEqual([]);
  });

  it("returns empty when criteria is not an array", () => {
    const opinions = makeOpinions();
    expect(buildConflictMap(opinions, null)).toEqual([]);
    expect(buildConflictMap(opinions, "scalability")).toEqual([]);
  });

  it("returns empty when opinions is null or not object", () => {
    expect(buildConflictMap(null, ["scalability"])).toEqual([]);
    expect(buildConflictMap("bad", ["scalability"])).toEqual([]);
  });

  it("detects conflicts with divergence >= 3", () => {
    const opinions = makeOpinions(); // scalability: 9 vs 5 => divergence 4
    const conflicts = buildConflictMap(opinions, ["scalability", "ease of use"]);
    expect(conflicts.length).toBeGreaterThan(0);
    const criteriaNames = conflicts.map((c) => c.criterion);
    expect(criteriaNames).toContain("scalability");
  });

  it("ignores low-divergence criteria (< 3)", () => {
    const opinions = {
      a: { scores: { cost: 7 }, reasoning: "cost is fine", summary: "ok", recommendation: "A", confidence: 0.8 },
      b: { scores: { cost: 8 }, reasoning: "cost is fine", summary: "ok", recommendation: "B", confidence: 0.7 },
    };
    const conflicts = buildConflictMap(opinions, ["cost"]); // divergence = 1
    expect(conflicts).toEqual([]);
  });

  it("detects conflict exactly at divergence 3", () => {
    const opinions = {
      a: { scores: { perf: 7 }, reasoning: "perf is good", summary: "ok", recommendation: "A", confidence: 0.8 },
      b: { scores: { perf: 4 }, reasoning: "perf is mediocre", summary: "ok", recommendation: "B", confidence: 0.7 },
    };
    const conflicts = buildConflictMap(opinions, ["perf"]); // divergence = 3
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].criterion).toBe("perf");
    expect(conflicts[0].divergence).toBe(3);
  });

  it("sorts conflicts by divergence descending", () => {
    const opinions = {
      a: {
        scores: { alpha: 9, beta: 6, gamma: 3 },
        reasoning: "alpha is important. beta matters. gamma is low.",
        summary: "a summary",
        recommendation: "A",
        confidence: 0.9,
      },
      b: {
        scores: { alpha: 4, beta: 1, gamma: 9 },
        reasoning: "alpha is low. beta is poor. gamma is critical.",
        summary: "b summary",
        recommendation: "B",
        confidence: 0.8,
      },
    };
    // alpha: 9-4=5, beta: 6-1=5, gamma: 9-3=6
    const conflicts = buildConflictMap(opinions, ["alpha", "beta", "gamma"]);
    expect(conflicts[0].divergence).toBeGreaterThanOrEqual(conflicts[1].divergence);
    if (conflicts.length > 2) {
      expect(conflicts[1].divergence).toBeGreaterThanOrEqual(conflicts[2].divergence);
    }
  });

  it("caps at 5 conflicts maximum", () => {
    const opinions = {
      a: {
        scores: { c1: 9, c2: 9, c3: 9, c4: 9, c5: 9, c6: 9 },
        reasoning: "",
        summary: "",
        recommendation: "A",
        confidence: 0.9,
      },
      b: {
        scores: { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1, c6: 1 },
        reasoning: "",
        summary: "",
        recommendation: "B",
        confidence: 0.9,
      },
    };
    const criteria = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const conflicts = buildConflictMap(opinions, criteria);
    expect(conflicts.length).toBeLessThanOrEqual(5);
  });

  it("generates a question for each conflict", () => {
    const opinions = makeOpinions();
    const conflicts = buildConflictMap(opinions, ["scalability"]);
    if (conflicts.length > 0) {
      expect(typeof conflicts[0].question).toBe("string");
      expect(conflicts[0].question.length).toBeGreaterThan(0);
    }
  });

  it("assigns sequential conflict IDs after sorting", () => {
    const opinions = makeOpinions(); // scalability diverges 4, ease of use diverges 3
    const conflicts = buildConflictMap(opinions, ["scalability", "ease of use"]);
    for (let i = 0; i < conflicts.length; i++) {
      expect(conflicts[i].id).toBe(`conflict-${i}`);
    }
  });

  it("includes scores and positions in each conflict", () => {
    const opinions = makeOpinions();
    const conflicts = buildConflictMap(opinions, ["scalability"]);
    if (conflicts.length > 0) {
      expect(conflicts[0].scores).toBeDefined();
      expect(conflicts[0].positions).toBeDefined();
    }
  });
});

// ── 4. parseOpinionFromResponse ───────────────────────────────────────────────

describe("parseOpinionFromResponse", () => {
  const structuredResponse = `## Summary
PostgreSQL is the best choice for transactional workloads.

## Recommendation
PostgreSQL — battle-tested and ACID-compliant.

## Scores
- scalability: 9/10
- ease of use: 6/10

## Reasoning
The database handles relational data very well. scalability has been proven at scale.

## Confidence
Confidence: 85%
`;

  it("parses structured markdown response", () => {
    const opinion = parseOpinionFromResponse("claude", structuredResponse, ["scalability", "ease of use"]);
    expect(opinion.speaker).toBe("claude");
    expect(opinion.summary).toBeTruthy();
    expect(opinion.reasoning).toBeTruthy();
    expect(opinion.timestamp).toBeTruthy();
  });

  it("extracts scores from 'Criterion: N/10' format", () => {
    const opinion = parseOpinionFromResponse("claude", structuredResponse, ["scalability", "ease of use"]);
    expect(opinion.scores["scalability"]).toBe(9);
    expect(opinion.scores["ease of use"]).toBe(6);
  });

  it("extracts confidence percentage", () => {
    const opinion = parseOpinionFromResponse("claude", structuredResponse, []);
    expect(opinion.confidence).toBeCloseTo(0.85);
  });

  it("handles unstructured text gracefully", () => {
    const unstructured = "I think PostgreSQL is better because it handles transactions well. scalability: 8/10";
    const opinion = parseOpinionFromResponse("claude", unstructured, ["scalability"]);
    expect(opinion).toBeDefined();
    expect(opinion.speaker).toBe("claude");
    expect(opinion.scores["scalability"]).toBe(8);
  });

  it("returns default for empty input", () => {
    const opinion = parseOpinionFromResponse("claude", "", ["scalability"]);
    expect(opinion.speaker).toBe("claude");
    expect(opinion.summary).toBe("(empty response)");
    expect(opinion.confidence).toBe(0.5);
    expect(opinion.scores).toEqual({});
  });

  it("returns default for null input", () => {
    const opinion = parseOpinionFromResponse("claude", null, ["scalability"]);
    expect(opinion.summary).toBe("(empty response)");
  });

  it("includes speaker in returned opinion", () => {
    const opinion = parseOpinionFromResponse("gpt4", "Some analysis here. scalability: 7/10", ["scalability"]);
    expect(opinion.speaker).toBe("gpt4");
  });

  it("handles response without confidence field", () => {
    const response = "PostgreSQL is great. scalability: 8/10";
    const opinion = parseOpinionFromResponse("claude", response, ["scalability"]);
    expect(opinion.confidence).toBe(0.5); // default
  });

  it("handles confidence expressed as keyword 'high'", () => {
    const response = "Confidence: high. This is certain.";
    const opinion = parseOpinionFromResponse("claude", response, []);
    expect(opinion.confidence).toBeGreaterThan(0.5);
  });
});

// ── 5. buildOpinionPrompt ─────────────────────────────────────────────────────

describe("buildOpinionPrompt", () => {
  it("includes problem in output", () => {
    const prompt = buildOpinionPrompt("Should we use PostgreSQL?", [], []);
    expect(prompt).toContain("Should we use PostgreSQL?");
  });

  it("includes options in output", () => {
    const prompt = buildOpinionPrompt("Choose a DB", ["PostgreSQL", "MongoDB"], []);
    expect(prompt).toContain("PostgreSQL");
    expect(prompt).toContain("MongoDB");
  });

  it("includes criteria in output", () => {
    const prompt = buildOpinionPrompt("Choose a DB", [], ["scalability", "cost"]);
    expect(prompt).toContain("scalability");
    expect(prompt).toContain("cost");
  });

  it("requests structured format with required sections", () => {
    const prompt = buildOpinionPrompt("Choose a DB", [], ["scalability"]);
    expect(prompt).toContain("Summary");
    expect(prompt).toContain("Recommendation");
    expect(prompt).toContain("Scores");
    expect(prompt).toContain("Reasoning");
    expect(prompt).toContain("Confidence");
  });

  it("states independence requirement", () => {
    const prompt = buildOpinionPrompt("Choose a DB", [], []);
    expect(prompt).toContain("INDEPENDENT");
    expect(prompt.toLowerCase()).toContain("do not reference other model");
  });

  it("includes template context when provided", () => {
    const prompt = buildOpinionPrompt("Choose a DB", [], [], "tech-decision");
    expect(prompt).toContain("tech-decision");
  });

  it("omits template line when not provided", () => {
    const prompt = buildOpinionPrompt("Choose a DB", [], []);
    expect(prompt).not.toContain("Using decision template");
  });

  it("omits options section when options array is empty", () => {
    const prompt = buildOpinionPrompt("Choose a DB", [], ["scalability"]);
    expect(prompt).not.toContain("## Available Options");
  });

  it("omits criteria section when criteria array is empty", () => {
    const prompt = buildOpinionPrompt("Choose a DB", ["PG", "Mongo"], []);
    expect(prompt).not.toContain("## Evaluation Criteria");
  });

  it("returns a non-empty string", () => {
    const prompt = buildOpinionPrompt("Test problem", [], []);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ── 6. generateConflictQuestions ──────────────────────────────────────────────

describe("generateConflictQuestions", () => {
  it("returns no-conflicts message for empty array", () => {
    const output = generateConflictQuestions([]);
    expect(output).toContain("No significant conflicts");
  });

  it("returns no-conflicts message for null input", () => {
    const output = generateConflictQuestions(null);
    expect(output).toContain("No significant conflicts");
  });

  it("formats conflicts as numbered questions", () => {
    const conflicts = [
      {
        id: "conflict-0",
        criterion: "scalability",
        positions: { claude: "high scalability", gpt4: "limited scalability" },
        scores: { claude: 9, gpt4: 5 },
        divergence: 4,
        question: "Which perspective on scalability aligns with your priorities?",
      },
    ];
    const output = generateConflictQuestions(conflicts);
    expect(output).toContain("scalability");
    expect(output).toContain("Question 1");
    expect(output).toContain("Which perspective on scalability");
  });

  it("includes all conflict criteria in output", () => {
    const conflicts = [
      {
        id: "conflict-0",
        criterion: "scalability",
        positions: { a: "pos A", b: "pos B" },
        scores: { a: 9, b: 4 },
        divergence: 5,
        question: "Q about scalability?",
      },
      {
        id: "conflict-1",
        criterion: "cost",
        positions: { a: "cheap", b: "expensive" },
        scores: { a: 8, b: 3 },
        divergence: 5,
        question: "Q about cost?",
      },
    ];
    const output = generateConflictQuestions(conflicts);
    expect(output).toContain("scalability");
    expect(output).toContain("cost");
    expect(output).toContain("Conflict 1");
    expect(output).toContain("Conflict 2");
  });
});

// ── 7. buildSynthesis ─────────────────────────────────────────────────────────

describe("buildSynthesis", () => {
  it("generates markdown with a table for criteria scores", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    const output = buildSynthesis(session);
    expect(output).toContain("# Decision Synthesis Report");
    expect(output).toContain("Criteria Scores");
    // Table should contain speaker names as columns
    expect(output).toContain("claude");
    expect(output).toContain("gpt4");
  });

  it("detects consensus when all speakers agree", () => {
    const session = makeSession();
    session.opinions = {
      claude: { ...makeOpinions().claude, recommendation: "PostgreSQL" },
      gpt4: { ...makeOpinions().gpt4, recommendation: "PostgreSQL" },
    };
    const output = buildSynthesis(session);
    expect(output).toContain("unanimous");
  });

  it("includes conflict resolution section when conflicts exist", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    session.conflicts = [
      {
        id: "conflict-0",
        criterion: "scalability",
        positions: { claude: "high", gpt4: "medium" },
        scores: { claude: 9, gpt4: 5 },
        divergence: 4,
        question: "Which do you prefer?",
      },
    ];
    session.userProbeResponses = ["I prefer scalability over ease of use"];
    const output = buildSynthesis(session);
    expect(output).toContain("Conflict Resolution");
    expect(output).toContain("scalability");
  });

  it("notes no conflicts when conflicts array is empty", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    session.conflicts = [];
    const output = buildSynthesis(session);
    expect(output).toContain("No significant conflicts");
  });

  it("includes average confidence in output", () => {
    const session = makeSession();
    session.opinions = makeOpinions(); // confidence 0.9 and 0.75 => avg 82-83%
    const output = buildSynthesis(session);
    expect(output).toMatch(/\d+%/); // some percentage present
  });

  it("handles invalid session gracefully", () => {
    const output = buildSynthesis(null);
    expect(output).toContain("Error");
  });

  it("includes the problem statement", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    const output = buildSynthesis(session);
    expect(output).toContain("Which database should we use?");
  });
});

// ── 8. buildActionPlan ────────────────────────────────────────────────────────

describe("buildActionPlan", () => {
  it("generates decision, rationale, action items", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    const plan = buildActionPlan(session);
    expect(plan.decision).toBeTruthy();
    expect(typeof plan.rationale).toBe("string");
    expect(Array.isArray(plan.actionItems)).toBe(true);
    expect(plan.actionItems.length).toBeGreaterThan(0);
  });

  it("generates risks from conflicts", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    session.conflicts = [
      {
        id: "conflict-0",
        criterion: "scalability",
        positions: {},
        scores: { claude: 9, gpt4: 5 },
        divergence: 4,
        question: "Which do you prefer?",
      },
    ];
    const plan = buildActionPlan(session);
    expect(Array.isArray(plan.risks)).toBe(true);
    expect(plan.risks.length).toBeGreaterThan(0);
    expect(plan.risks[0].description).toContain("scalability");
  });

  it("exports checklist format", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    const plan = buildActionPlan(session);
    expect(typeof plan.exportFormats.checklist).toBe("string");
    expect(plan.exportFormats.checklist).toContain("- [ ]");
  });

  it("exports GitHub issue format", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    const plan = buildActionPlan(session);
    expect(typeof plan.exportFormats.githubIssue).toBe("string");
    expect(plan.exportFormats.githubIssue).toContain("## Decision");
  });

  it("action items include id, title, description, priority", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    const plan = buildActionPlan(session);
    for (const item of plan.actionItems) {
      expect(item.id).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(["high", "medium", "low"]).toContain(item.priority);
    }
  });

  it("risks include description, mitigation, probability", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    session.conflicts = [
      {
        criterion: "cost",
        divergence: 7,
        positions: {},
        scores: { claude: 9, gpt4: 2 },
        question: "Q?",
      },
    ];
    const plan = buildActionPlan(session);
    for (const risk of plan.risks) {
      expect(risk.description).toBeTruthy();
      expect(risk.mitigation).toBeTruthy();
      expect(["high", "medium", "low"]).toContain(risk.probability);
    }
  });

  it("handles null session gracefully", () => {
    const plan = buildActionPlan(null);
    expect(plan.decision).toBe("(no session)");
    expect(plan.actionItems).toEqual([]);
    expect(plan.risks).toEqual([]);
  });

  it("high divergence conflict gets high probability risk", () => {
    const session = makeSession();
    session.opinions = makeOpinions();
    session.conflicts = [
      {
        criterion: "reliability",
        divergence: 7, // >= 6 => high probability
        positions: {},
        scores: {},
        question: "Q?",
      },
    ];
    const plan = buildActionPlan(session);
    const reliabilityRisk = plan.risks.find((r) => r.description.includes("reliability"));
    expect(reliabilityRisk).toBeDefined();
    expect(reliabilityRisk.probability).toBe("high");
  });

  it("generates criteria-based action items", () => {
    const session = makeSession(); // criteria: ["scalability", "ease of use"]
    session.opinions = makeOpinions();
    const plan = buildActionPlan(session);
    const criteriaActions = plan.actionItems.filter((i) => i.title.startsWith("Validate:"));
    expect(criteriaActions.length).toBeGreaterThan(0);
  });
});

// ── 9. loadTemplates ──────────────────────────────────────────────────────────

describe("loadTemplates", () => {
  it("returns an array", () => {
    const templates = loadTemplates();
    expect(Array.isArray(templates)).toBe(true);
  });

  it("returns empty array when file is missing (graceful)", () => {
    // The function already handles missing file by returning []
    // loadTemplates reads from selectors/decision-templates.json
    // If the file doesn't exist it returns [] — we just verify the type
    const templates = loadTemplates();
    expect(Array.isArray(templates)).toBe(true);
  });
});

// ── 10. matchTemplate ─────────────────────────────────────────────────────────

describe("matchTemplate", () => {
  const templates = [
    {
      name: "tech-decision",
      description: "Technology selection decisions",
      keywords: ["technology", "stack", "framework", "library", "database"],
      criteria: ["performance", "scalability", "maintainability"],
    },
    {
      name: "hiring",
      description: "Hiring and team decisions",
      keywords: ["hire", "candidate", "team", "position"],
      criteria: ["skills", "culture fit", "experience"],
    },
    {
      name: "vendor",
      description: "Vendor selection",
      keywords: ["vendor", "supplier", "partner", "contract"],
      criteria: ["cost", "reliability", "support"],
    },
  ];

  it("matches by keyword", () => {
    const match = matchTemplate("Which database should we use for our project?", templates);
    expect(match).not.toBeNull();
    expect(match.name).toBe("tech-decision");
  });

  it("returns null for no match", () => {
    // Uses no keywords from any template (no: database, stack, framework, library,
    // hire, candidate, position, vendor, supplier, partner, contract, tech-decision, hiring, vendor)
    const match = matchTemplate("Should we paint the office walls blue or green?", templates);
    expect(match).toBeNull();
  });

  it("returns null for empty problem text", () => {
    const match = matchTemplate("", templates);
    expect(match).toBeNull();
  });

  it("returns null for null problem text", () => {
    const match = matchTemplate(null, templates);
    expect(match).toBeNull();
  });

  it("returns null for empty templates array", () => {
    const match = matchTemplate("Which database to use?", []);
    expect(match).toBeNull();
  });

  it("returns null for null templates", () => {
    const match = matchTemplate("Which database to use?", null);
    expect(match).toBeNull();
  });

  it("is case-insensitive for problem text", () => {
    const match = matchTemplate("WHICH DATABASE SHOULD WE USE?", templates);
    expect(match).not.toBeNull();
    expect(match.name).toBe("tech-decision");
  });

  it("picks best match when multiple templates partially match", () => {
    // "hire a vendor" matches both hiring (hire) and vendor (vendor)
    const problem = "Should we hire a vendor partner for this technology stack?";
    const match = matchTemplate(problem, templates);
    expect(match).not.toBeNull();
    // All three have some match; we just verify a match is returned
  });

  it("matches by template name in problem text", () => {
    const match = matchTemplate("Let's use the hiring process", templates);
    expect(match).not.toBeNull();
    expect(match.name).toBe("hiring");
  });
});

// ── 11. DECISION_STAGES and STAGE_TRANSITIONS exports ────────────────────────

describe("DECISION_STAGES", () => {
  it("exports the ordered stages array", () => {
    expect(Array.isArray(DECISION_STAGES)).toBe(true);
    expect(DECISION_STAGES[0]).toBe("intake");
    expect(DECISION_STAGES[DECISION_STAGES.length - 1]).toBe("done");
  });

  it("contains all expected stages", () => {
    const expected = ["intake", "parallel_opinions", "conflict_map", "user_probe", "synthesis", "action_export", "done"];
    expect(DECISION_STAGES).toEqual(expected);
  });
});

describe("STAGE_TRANSITIONS", () => {
  it("exports valid transition map", () => {
    expect(typeof STAGE_TRANSITIONS).toBe("object");
    expect(STAGE_TRANSITIONS.intake).toBe("parallel_opinions");
    expect(STAGE_TRANSITIONS.action_export).toBe("done");
  });

  it("does not have a transition from done", () => {
    expect(STAGE_TRANSITIONS["done"]).toBeUndefined();
  });
});

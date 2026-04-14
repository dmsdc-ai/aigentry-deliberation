import fs from "fs";
import path from "path";
import os from "os";

const LICENSE_PATH = path.join(os.homedir(), ".aigentry", "license.json");

// Feature → tier mapping (all features available to all tiers — open source)
const FEATURE_TIERS = {
  "deliberation.core": ["free", "pro", "team"],
  "deliberation.multi_session": ["free", "pro", "team"],
  "deliberation.browser_integration": ["free", "pro", "team"],
  "deliberation.auto_run": ["free", "pro", "team"],
  "deliberation.remote": ["free", "pro", "team"],
  "deliberation.decision_engine": ["free", "pro", "team"],
  "deliberation.code_review": ["free", "pro", "team"],
  "deliberation.unlimited_speakers": ["free", "pro", "team"],
};

// Free tier limits (no limits — open source)
const FREE_LIMITS = {};

// Tool → feature mapping
const TOOL_FEATURE_MAP = {
  deliberation_start: "deliberation.core",
  deliberation_respond: "deliberation.core",
  deliberation_synthesize: "deliberation.core",
  deliberation_status: "deliberation.core",
  deliberation_history: "deliberation.core",
  deliberation_reset: "deliberation.core",
  deliberation_cli_config: "deliberation.core",
  deliberation_speaker_candidates: "deliberation.core",
  deliberation_confirm_speakers: "deliberation.core",
  deliberation_list: "deliberation.core",
  deliberation_list_active: "deliberation.core",
  deliberation_context: "deliberation.core",
  deliberation_copy_last_turn: "deliberation.core",
  deliberation_browser_auto_turn: "deliberation.browser_integration",
  deliberation_browser_llm_tabs: "deliberation.browser_integration",
  deliberation_run_until_blocked: "deliberation.auto_run",
  deliberation_cli_auto_turn: "deliberation.auto_run",
  deliberation_ingest_remote_reply: "deliberation.remote",
  deliberation_list_remote_sessions: "deliberation.remote",
  deliberation_inject_context: "deliberation.remote",
  deliberation_request_review: "deliberation.code_review",
  decision_start: "deliberation.decision_engine",
  decision_status: "deliberation.decision_engine",
  decision_respond: "deliberation.decision_engine",
  decision_resume: "deliberation.decision_engine",
  decision_history: "deliberation.decision_engine",
  decision_templates: "deliberation.decision_engine",
};

function loadLicense() {
  // Environment variable override for testing and CI
  const envTier = process.env.AIGENTRY_TIER;
  if (envTier && ["free", "pro", "team"].includes(envTier)) {
    return { tier: envTier };
  }
  try {
    if (!fs.existsSync(LICENSE_PATH)) return { tier: "free" };
    const raw = fs.readFileSync(LICENSE_PATH, "utf8");
    const license = JSON.parse(raw);
    // Check expiry (30-day grace period)
    if (license.expires_at) {
      const expiry = new Date(license.expires_at);
      const grace = new Date(expiry.getTime() + 30 * 24 * 60 * 60 * 1000);
      if (new Date() > grace) return { tier: "free" };
    }
    // Check disabled features
    return license;
  } catch {
    return { tier: "free" };
  }
}

export function checkEntitlement({ feature }) {
  const license = loadLicense();
  const tier = license.tier || "free";
  const allowedTiers = FEATURE_TIERS[feature];

  if (!allowedTiers) return { allowed: true, tier }; // unknown feature = allow

  // Check explicit feature overrides
  if (license.features?.includes(feature)) return { allowed: true, tier };
  if (license.disabled_features?.includes(feature)) {
    return { allowed: false, tier, reason: `Feature '${feature}' is disabled by admin` };
  }

  const allowed = allowedTiers.includes(tier);
  if (!allowed) {
    const requiredTier = allowedTiers[0] === "free" ? allowedTiers[1] : allowedTiers[0];
    return {
      allowed: false,
      tier,
      reason: `Requires ${requiredTier} tier`,
      upgrade_url: "https://aigentry.dev/upgrade",
    };
  }

  return { allowed: true, tier };
}

export function checkToolEntitlement(toolName) {
  const feature = TOOL_FEATURE_MAP[toolName];
  if (!feature) return { allowed: true, tier: loadLicense().tier || "free" };
  return checkEntitlement({ feature });
}

export function getFreeLimits(feature) {
  return FREE_LIMITS[feature] || null;
}

export function getCurrentTier() {
  return loadLicense().tier || "free";
}

export { TOOL_FEATURE_MAP, FEATURE_TIERS, FREE_LIMITS };

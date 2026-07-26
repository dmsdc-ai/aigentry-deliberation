/**
 * i18n — Dynamic language detection and translation helper
 *
 * Default language is English. When a user writes in Korean,
 * the system detects it and responds in Korean from that point.
 */

const KOREAN_RANGE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

/**
 * Detect language from text. Returns "ko" if Korean characters are found, "en" otherwise.
 * @param {string} text
 * @returns {"en"|"ko"}
 */
export function detectLang(text) {
  if (!text || typeof text !== "string") return "en";
  return KOREAN_RANGE.test(text) ? "ko" : "en";
}

/**
 * Return the appropriate translation based on language.
 * @param {string} en - English text (default)
 * @param {string} ko - Korean text
 * @param {string} [lang="en"] - Target language
 * @returns {string}
 */
export function t(en, ko, lang) {
  return lang === "ko" ? ko : en;
}

/**
 * Category B — Data context assertions.
 *
 * After a click step executes, verifies that "key words" captured from the
 * surrounding row/card at record time are still present on the page.
 *
 * Catches bugs like:
 *   • Edit button opens the wrong row's record
 *   • Modal/form shows stale or mismatched data
 *   • Wrong item selected in a list
 *
 * Design notes:
 *   • "Soft" assertion — warns but does NOT fail the functional test.
 *   • Ignores generic UI words (Save, Cancel, Edit, Delete, …) and very short
 *     tokens so we only flag on actual data identifiers (names, emails, IDs…).
 *   • Only runs for `click` and `dblclick` steps that have a `contextText`.
 */

// ── Stop-words: UI labels & very common English words that aren't data ────────
const STOP_WORDS = new Set([
  // UI actions
  "edit", "delete", "save", "cancel", "close", "submit", "add", "remove",
  "update", "view", "open", "yes", "no", "ok", "confirm", "back", "next",
  "previous", "more", "less", "all", "none", "select", "deselect", "clear",
  "reset", "search", "filter", "sort", "export", "import", "upload", "download",
  // Common English
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "had", "her", "was", "one", "our", "out", "day", "get", "has", "him",
  "his", "how", "man", "new", "now", "old", "see", "two", "way", "who",
  "boy", "did", "its", "let", "put", "say", "she", "too", "use", "that",
  "this", "with", "have", "from", "they", "will", "been", "each", "which",
  "there", "their", "about", "would", "other", "into", "than", "then",
  "some", "what", "when", "your", "also", "just", "like", "only", "over",
  // Status badges / column headers that appear everywhere
  "active", "inactive", "enabled", "disabled", "true", "false", "null",
  "status", "action", "actions", "name", "email", "phone", "date", "type",
  "created", "updated", "modified", "pending", "approved", "rejected",
]);

const MIN_KEYWORD_LEN = 4;
const MIN_KEYWORDS_TO_CHECK = 2; // Only run check if we found at least 2 keywords
const PASS_RATIO = 0.5;          // At least 50% of keywords must be found

/**
 * Extract meaningful data tokens from a context text string.
 * Filters out stop-words, pure numbers, and short tokens.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  if (!text || typeof text !== "string") return [];

  return text
    .replace(/[|•·\/\\()\[\]{}<>]/g, " ") // Split on common list separators
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9@.\-_+]/g, "").trim())
    .filter((t) => {
      if (t.length < MIN_KEYWORD_LEN) return false;
      if (/^\d+$/.test(t)) return false;          // Pure numbers (IDs change)
      if (STOP_WORDS.has(t.toLowerCase())) return false;
      return true;
    })
    // Deduplicate, preserve order
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 15); // Cap at 15 to keep checks fast
}

/**
 * Check whether the data context captured at record time is still visible
 * on the page after a step executes.
 *
 * @param {import('puppeteer').Page} page   Puppeteer page object
 * @param {Object} step                     Step object from the test case
 * @returns {Promise<{ status: 'skip'|'pass'|'warn', message?: string, missing?: string[], found?: string[] }>}
 */
async function checkDataContext(page, step) {
  // Only applies to click actions with captured context text
  if (!step || !["click", "dblclick"].includes(step.action)) {
    return { status: "skip" };
  }
  if (!step.contextText || step.contextText.trim().length < 5) {
    return { status: "skip" };
  }

  const keywords = extractKeywords(step.contextText);
  if (keywords.length < MIN_KEYWORDS_TO_CHECK) {
    return { status: "skip", message: `Not enough keywords (${keywords.length}) extracted from contextText` };
  }

  let pageText;
  try {
    pageText = await page.evaluate(() => {
      // Get all visible text — inputs, textareas, and plain text nodes
      const parts = [];
      document.querySelectorAll("input, textarea, select").forEach((el) => {
        if (el.value) parts.push(el.value);
      });
      parts.push(document.body.innerText || document.body.textContent || "");
      return parts.join(" ");
    });
  } catch (err) {
    return { status: "skip", message: `Page evaluate failed: ${err.message}` };
  }

  const pageTextLower = pageText.toLowerCase();
  const found = keywords.filter((kw) => pageTextLower.includes(kw.toLowerCase()));
  const missing = keywords.filter((kw) => !pageTextLower.includes(kw.toLowerCase()));
  const ratio = found.length / keywords.length;

  if (ratio >= PASS_RATIO) {
    return {
      status: "pass",
      message: `${found.length}/${keywords.length} context keywords found on page`,
      found,
      missing,
    };
  }

  return {
    status: "warn",
    message: `Only ${found.length}/${keywords.length} context keywords found — possible wrong data (missing: ${missing.slice(0, 5).join(", ")})`,
    found,
    missing,
  };
}

module.exports = { extractKeywords, checkDataContext };

/**
 * Bug detectors for Categories C, D, E.
 *
 * C — Console errors & failed network requests
 * D — Stuck UI state (loading spinners, disabled submit buttons)
 * E — Navigation failures (wrong URL, error pages after clicks)
 */

// ── C: Console & Network monitors ─────────────────────────────────────────────

/**
 * Attach console-error and request-failure listeners to a Puppeteer page.
 * Call once at the start of a test case; call getIssues() to retrieve collected items.
 * @param {import('puppeteer').Page} page
 * @returns {{ getIssues: () => Array, clear: () => void }}
 */
function setupPageMonitors(page) {
  const issues = [];

  // Console errors
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Skip noisy browser-internal / extension messages
      if (
        text.includes("ERR_BLOCKED_BY_CLIENT") ||
        text.includes("chrome-extension://") ||
        text.includes("favicon.ico") ||
        text.includes("net::ERR_ABORTED")
      ) return;
      issues.push({ category: "C", type: "console_error", message: text.slice(0, 200) });
    }
  });

  // Failed network requests
  page.on("requestfailed", (req) => {
    const url = req.url();
    if (url.startsWith("chrome-extension://") || url.includes("favicon")) return;
    const failure = req.failure()?.errorText || "unknown";
    // Only flag non-abort failures (aborts are often intentional cancellations)
    if (failure === "net::ERR_ABORTED") return;
    issues.push({
      category: "C",
      type: "network_error",
      message: `${req.method()} ${url.slice(0, 120)} failed: ${failure}`,
    });
  });

  // HTTP 4xx/5xx responses
  page.on("response", (res) => {
    const status = res.status();
    if (status >= 400) {
      const url = res.url();
      if (url.includes("favicon") || url.startsWith("chrome-extension://")) return;
      issues.push({
        category: "C",
        type: "http_error",
        message: `HTTP ${status} — ${url.slice(0, 120)}`,
      });
    }
  });

  return {
    getIssues: () => [...issues],
    clear: () => { issues.length = 0; },
  };
}

// ── D: Stuck UI state detection ───────────────────────────────────────────────

const LOADING_SELECTORS = [
  "[class*='loading']:not([class*='no-loading'])",
  "[class*='spinner']:not([class*='hide'])",
  "[class*='skeleton']",
  "[aria-busy='true']",
  "[data-loading='true']",
  ".MuiCircularProgress-root",
  ".MuiLinearProgress-root",
  "[class*='Skeleton']",
].join(", ");

const ERROR_PAGE_PATTERNS = [
  /\b404\b.*not found/i,
  /page not found/i,
  /something went wrong/i,
  /internal server error/i,
  /\b500\b.*error/i,
  /access denied/i,
  /\b403\b.*forbidden/i,
  /oops.*error/i,
];

/**
 * After a step completes, check for stuck loading indicators or disabled submit buttons.
 * @param {import('puppeteer').Page} page
 * @param {number} stepIndex
 * @returns {Promise<Array>}
 */
async function checkPageState(page, stepIndex) {
  const issues = [];
  try {
    const result = await page.evaluate((loadingSel) => {
      // Check for visible loading spinners still on screen
      const loadingEls = [...document.querySelectorAll(loadingSel)]
        .filter((el) => {
          const s = window.getComputedStyle(el);
          return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
        });

      // Check for disabled primary submit/save buttons (may indicate a broken form state)
      const disabledPrimary = [...document.querySelectorAll(
        "button[type='submit']:disabled, button.MuiButton-containedPrimary:disabled, [data-testid*='submit']:disabled",
      )].length;

      return { loadingCount: loadingEls.length, disabledPrimary };
    }, LOADING_SELECTORS);

    if (result.loadingCount > 0) {
      issues.push({
        category: "D",
        type: "stuck_loading",
        step: stepIndex + 1,
        message: `${result.loadingCount} loading indicator(s) still visible after step completed`,
      });
    }
    if (result.disabledPrimary > 0) {
      issues.push({
        category: "D",
        type: "disabled_submit",
        step: stepIndex + 1,
        message: `${result.disabledPrimary} primary submit button(s) are disabled`,
      });
    }
  } catch (_) {}
  return issues;
}

// ── E: Navigation verification ────────────────────────────────────────────────

/**
 * After a step that may cause navigation, check:
 *   1. URL actually changed (if the step was a link/nav click)
 *   2. The new page isn't an error page (404, 500, blank)
 *
 * @param {import('puppeteer').Page} page
 * @param {Object} step         Step object from test case
 * @param {string} prevUrl      URL before the step executed
 * @param {number} stepIndex
 * @returns {Promise<Array>}
 */
async function checkNavigation(page, step, prevUrl, stepIndex) {
  const issues = [];
  try {
    const currentUrl = page.url();

    // Check for error page content regardless of URL
    const pageTitle = await page.title().catch(() => "");
    const bodySnippet = await page.evaluate(() =>
      (document.body?.innerText || "").slice(0, 500)
    ).catch(() => "");

    const isErrorPage = ERROR_PAGE_PATTERNS.some(
      (re) => re.test(pageTitle) || re.test(bodySnippet),
    );
    if (isErrorPage) {
      issues.push({
        category: "E",
        type: "error_page",
        step: stepIndex + 1,
        message: `Error page detected after step: "${pageTitle}" — ${currentUrl.slice(0, 100)}`,
      });
    }

    // If this was a link click / navigation action and URL didn't change, flag it
    const isNavAction =
      step?.action === "click" &&
      (step?.tagName === "A" ||
        (step?.selector || "").includes("link") ||
        (step?.description || "").toLowerCase().match(/\b(go to|navigate|open|view)\b/));

    if (isNavAction && prevUrl && currentUrl === prevUrl && !isErrorPage) {
      issues.push({
        category: "E",
        type: "no_navigation",
        step: stepIndex + 1,
        message: `Navigation click didn't change URL (stayed at ${currentUrl.slice(0, 80)})`,
      });
    }
  } catch (_) {}
  return issues;
}

module.exports = { setupPageMonitors, checkPageState, checkNavigation };

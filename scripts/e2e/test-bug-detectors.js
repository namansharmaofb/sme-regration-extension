/**
 * Tests for bug-detectors.js (Categories C, D, E)
 * Run: node scripts/e2e/test-bug-detectors.js
 */
const { setupPageMonitors, checkPageState, checkNavigation } = require("./bug-detectors");

let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// ── Mock helpers ──────────────────────────────────────────────────────────────
function mockPage({ bodyText = "", title = "", url = "http://app.test/home", loadingCount = 0, disabledPrimary = 0 } = {}) {
  const listeners = {};
  return {
    on(event, fn) { listeners[event] = fn; },
    _emit(event, ...args) { listeners[event]?.(...args); },
    url: () => url,
    title: async () => title,
    evaluate: async (fn, ...args) => fn(...args, { loadingCount, disabledPrimary, innerText: bodyText }),
  };
}

// ── C: setupPageMonitors ──────────────────────────────────────────────────────
console.log("\n[C — setupPageMonitors]");
{
  const page = mockPage();
  const monitor = setupPageMonitors(page);

  // Simulate a console error
  page._emit("console", { type: () => "error", text: () => "Uncaught TypeError: Cannot read property" });
  // Simulate a blocked request (should be ignored)
  page._emit("console", { type: () => "error", text: () => "ERR_BLOCKED_BY_CLIENT something" });
  // Simulate a failed request
  page._emit("requestfailed", { url: () => "http://api.test/data", method: () => "GET", failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }) });
  // Simulate favicon fail (should be ignored)
  page._emit("requestfailed", { url: () => "http://app.test/favicon.ico", method: () => "GET", failure: () => ({ errorText: "net::ERR_ABORTED" }) });
  // Simulate 4xx response
  page._emit("response", { status: () => 404, url: () => "http://api.test/user/99" });
  // Simulate 2xx response (should be ignored)
  page._emit("response", { status: () => 200, url: () => "http://api.test/user/1" });

  const issues = monitor.getIssues();
  assert("captures console error", issues.some(i => i.type === "console_error"), JSON.stringify(issues));
  assert("ignores ERR_BLOCKED_BY_CLIENT", !issues.some(i => i.message?.includes("ERR_BLOCKED_BY_CLIENT")));
  assert("captures network failure", issues.some(i => i.type === "network_error"), JSON.stringify(issues));
  assert("ignores favicon failures", !issues.some(i => i.message?.includes("favicon")));
  assert("captures HTTP 404", issues.some(i => i.type === "http_error"), JSON.stringify(issues));
  assert("ignores 200 responses", issues.filter(i => i.type === "http_error").every(i => !i.message?.includes("user/1")));
  assert("all issues are category C", issues.every(i => i.category === "C"));

  monitor.clear();
  assert("clear() empties issues", monitor.getIssues().length === 0);
}

// ── D: checkPageState ─────────────────────────────────────────────────────────
console.log("\n[D — checkPageState]");
{
  // Mock page.evaluate to return loading state
  const evalFn = async (fn) => fn.toString().includes("loadingEls") ? { loadingCount: 2, disabledPrimary: 0 } : {};
  const page = { evaluate: evalFn };
  checkPageState(page, 2).then(issues => {
    assert("detects stuck loading spinners", issues.some(i => i.type === "stuck_loading"), JSON.stringify(issues));
    assert("loading issue is category D", issues.every(i => i.category === "D"));
  });
}
{
  const evalFn = async (fn) => fn.toString().includes("loadingEls") ? { loadingCount: 0, disabledPrimary: 1 } : {};
  const page = { evaluate: evalFn };
  checkPageState(page, 3).then(issues => {
    assert("detects disabled submit button", issues.some(i => i.type === "disabled_submit"), JSON.stringify(issues));
  });
}
{
  const evalFn = async (fn) => fn.toString().includes("loadingEls") ? { loadingCount: 0, disabledPrimary: 0 } : {};
  const page = { evaluate: evalFn };
  checkPageState(page, 1).then(issues => {
    assert("returns empty when page is healthy", issues.length === 0);
  });
}

// ── E: checkNavigation ────────────────────────────────────────────────────────
console.log("\n[E — checkNavigation]");
{
  // Error page detection
  const page = { url: () => "http://app.test/error", title: async () => "404 Not Found", evaluate: async () => "Page not found" };
  checkNavigation(page, { action: "click" }, "http://app.test/list", 4).then(issues => {
    assert("detects 404 error page", issues.some(i => i.type === "error_page"), JSON.stringify(issues));
    assert("error page issue is category E", issues.every(i => i.category === "E"));
  });
}
{
  // Navigation didn't happen for a link click
  const page = { url: () => "http://app.test/list", title: async () => "List", evaluate: async () => "normal page content" };
  const step = { action: "click", tagName: "A", selector: "a.link", description: "go to details" };
  checkNavigation(page, step, "http://app.test/list", 5).then(issues => {
    assert("detects no-navigation for link click", issues.some(i => i.type === "no_navigation"), JSON.stringify(issues));
  });
}
{
  // Normal navigation — should produce no issues
  const page = { url: () => "http://app.test/details/5", title: async () => "Detail Page", evaluate: async () => "normal content" };
  const step = { action: "click", tagName: "A", description: "go to details" };
  checkNavigation(page, step, "http://app.test/list", 5).then(issues => {
    assert("no issue when navigation succeeds", issues.length === 0, JSON.stringify(issues));
  });
}
{
  // Regular button click (not a nav action) — no nav issue expected
  const page = { url: () => "http://app.test/list", title: async () => "List", evaluate: async () => "normal page" };
  const step = { action: "click", tagName: "BUTTON", description: "Save" };
  checkNavigation(page, step, "http://app.test/list", 6).then(issues => {
    assert("no nav issue for button clicks on same URL", issues.length === 0, JSON.stringify(issues));
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error("SOME TESTS FAILED"); process.exit(1); }
  else console.log("ALL TESTS PASSED ✓");
}, 200);

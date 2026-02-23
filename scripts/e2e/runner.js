const puppeteer = require("puppeteer");
const path = require("path");
const mysql = require("mysql2/promise");
const cleanupUser = require("./cleanup-user");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const EXTENSION_PATH = path.resolve(__dirname, "../../extension-src");
const TEST_EMAIL = process.env.E2E_TEST_EMAIL || "test@example.com";
const TARGET_URL = process.env.TARGET_URL || "http://localhost:3000";
const BACKEND_URL = "http://localhost:4000";

// ANSI color codes for terminal output
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

async function fetchTestIdByName(namePattern) {
  let connection;
  try {
    connection = await mysql.createConnection({
      socketPath: "/var/run/mysqld/mysqld.sock",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "test_recorder",
    });
    const [rows] = await connection.execute(
      "SELECT id FROM tests WHERE name LIKE ? LIMIT 1",
      [`%${namePattern}%`],
    );
    if (rows.length > 0) {
      console.log(
        `[DB Lookup] Found Test ID ${rows[0].id} for pattern "${namePattern}"`,
      );
      return rows[0].id;
    }
  } catch (err) {
    console.warn(
      `[DB Lookup] Failed to find test for "${namePattern}": ${err.message}`,
    );
  } finally {
    if (connection) await connection.end();
  }
  return null;
}

async function getWorker(browser) {
  // Always wait a tiny bit to let any reloads settle
  await new Promise((r) => setTimeout(r, 1000));

  const targets = browser
    .targets()
    .filter((t) => t.type() === "service_worker");
  if (targets.length > 0) {
    // Use the last target (most recently created service worker)
    const worker = await targets[targets.length - 1].worker();
    if (worker) {
      worker.on("console", (msg) =>
        console.log(`WORKER CONSOLE: ${msg.text()}`),
      );
      return worker;
    }
  }

  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === "service_worker",
    { timeout: 5000 },
  );
  const worker = await workerTarget.worker();
  if (worker) {
    worker.on("console", (msg) => console.log(`WORKER CONSOLE: ${msg.text()}`));
  }
  return worker;
}

// Helper Functions for Onboarding & Feature Phases
async function get_last_ai_message(page) {
  try {
    // Selector for the AI's latest message bubble
    const selector =
      ".ai-message:last-child, [data-testid='ai-response']:last-of-type";
    await page.waitForSelector(selector, { timeout: 5000 });
    const text = await page.$eval(selector, (el) => el.innerText);
    return text.trim();
  } catch (e) {
    console.warn("get_last_ai_message failed:", e.message);
    return "";
  }
}

function get_answer_for_question(question) {
  const q = question.toLowerCase();
  if (q.includes("name")) return "Test User";
  if (q.includes("goal")) return "Automated Testing";
  if (q.includes("company")) return "Acme Corp";

  console.warn(`No pattern match for "${question}". Defaulting to "yes".`);
  return "yes";
}

const fs = require("fs");

async function file_bug(testName, errorMsg, ariaSnapshotPath) {
  console.log(`[Bug Tracker] Filing bug for "${testName}"...`);

  const bugReport = {
    id: `BUG-${Date.now()}`,
    title: `Failure in ${testName}`,
    description: errorMsg,
    ariaSnapshot: ariaSnapshotPath || null,
    timestamp: new Date().toISOString(),
  };

  const reportFile = path.resolve(__dirname, "bug_reports.json");

  try {
    let reports = [];
    if (fs.existsSync(reportFile)) {
      const data = fs.readFileSync(reportFile, "utf8");
      try {
        reports = JSON.parse(data);
      } catch (e) {
        // file might be corrupt or empty, start fresh
      }
    }

    reports.push(bugReport);
    fs.writeFileSync(reportFile, JSON.stringify(reports, null, 2));

    console.log(`[Bug Tracker] Bug saved to ${reportFile}`);
    if (ariaSnapshotPath) {
      console.log(`[Bug Tracker] ARIA snapshot saved to ${ariaSnapshotPath}`);
    }
  } catch (err) {
    console.error(`[Bug Tracker] Failed to save bug report: ${err.message}`);
  }
}

function buildAriaSnapshotPath(prefix, testCaseId = "unknown") {
  return path.join(
    __dirname,
    "aria-snapshots",
    `aria_snapshot_${prefix}_${testCaseId}_${Date.now()}.json`,
  );
}

const GENERIC_ARIA_ICONS = new Set([
  "chevron_right",
  "chevron_left",
  "expand_more",
  "expand_less",
  "west",
  "east",
  "north",
  "south",
  "menu",
  "more_vert",
  "more_horiz",
  "close",
  "add",
  "remove",
  "search",
  "filter_list",
  "edit",
  "delete",
  "download",
  "file_download",
  "upload",
  "file_upload",
  "refresh",
]);

function normalizeText(value) {
  if (!value || typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isGenericAriaSelector(selector) {
  if (!selector || typeof selector !== "string") return false;
  if (!selector.startsWith("aria/")) return false;
  const name = normalizeText(selector.slice(5));
  return GENERIC_ARIA_ICONS.has(name);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function escapeAttributeValue(value) {
  return String(value).replace(/"/g, '\\"');
}

function normalizeSelector(selector) {
  if (!selector || typeof selector !== "string") return null;
  const raw = selector.trim();
  if (!raw) return null;

  if (
    raw.startsWith("aria/") ||
    raw.startsWith("xpath/") ||
    raw.startsWith("text/")
  ) {
    return raw;
  }

  if (raw.startsWith("//") || raw.startsWith("(//")) {
    return `xpath/${raw}`;
  }

  const eqIndex = raw.indexOf("=");
  if (eqIndex > 0) {
    const type = raw.slice(0, eqIndex).toLowerCase();
    const value = raw.slice(eqIndex + 1);
    switch (type) {
      case "css":
        return value;
      case "id":
        return `[id="${escapeAttributeValue(value)}"]`;
      case "name":
        return `[name="${escapeAttributeValue(value)}"]`;
      case "placeholder":
        return `[placeholder="${escapeAttributeValue(value)}"]`;
      case "testid":
        return `[data-testid="${escapeAttributeValue(
          value,
        )}"], [data-cy="${escapeAttributeValue(
          value,
        )}"], [data-test-id="${escapeAttributeValue(
          value,
        )}"], [data-qa="${escapeAttributeValue(value)}"]`;
      case "aria":
        return `aria/${value}`;
      case "xpath":
        return `xpath/${value}`;
      case "linktext":
        return `aria/${value}`;
      default:
        break;
    }
  }

  return raw;
}

function addSelector(out, selector) {
  const normalized = normalizeSelector(selector);
  if (normalized) out.push(normalized);
}

function selectorsFromTargets(targets) {
  const out = [];
  if (!Array.isArray(targets)) return out;
  for (const target of targets) {
    if (!target) continue;
    if (typeof target === "string") {
      addSelector(out, target);
      continue;
    }
    if (Array.isArray(target) && target.length > 0) {
      addSelector(out, target[0]);
      continue;
    }
    if (typeof target === "object" && target.type && target.value) {
      const type = String(target.type).toLowerCase();
      const value = String(target.value);
      switch (type) {
        case "aria":
          addSelector(out, `aria/${value}`);
          break;
        case "xpath":
          addSelector(out, `xpath/${value}`);
          break;
        case "css":
        case "css:finder":
          addSelector(out, value);
          break;
        case "id":
          addSelector(out, `id=${value}`);
          break;
        case "name":
          addSelector(out, `name=${value}`);
          break;
        case "placeholder":
          addSelector(out, `placeholder=${value}`);
          break;
        case "testid":
          addSelector(out, `testId=${value}`);
          break;
        case "linktext":
          addSelector(out, `linkText=${value}`);
          break;
        default:
          addSelector(out, value);
          break;
      }
    }
  }
  return out;
}

function buildSelectorCandidates(step) {
  const out = [];
  if (!step || typeof step !== "object") return out;

  if (Array.isArray(step.selectors)) {
    if (step.selectors.length > 0 && Array.isArray(step.selectors[0])) {
      for (const group of step.selectors) {
        if (!Array.isArray(group)) continue;
        for (const selector of group) addSelector(out, selector);
      }
    } else {
      for (const selector of step.selectors) addSelector(out, selector);
    }
  } else if (step.selectors && Array.isArray(step.selectors.selectors)) {
    for (const group of step.selectors.selectors) {
      if (Array.isArray(group)) {
        for (const selector of group) addSelector(out, selector);
      } else {
        addSelector(out, group);
      }
    }
  } else if (step.selectors && typeof step.selectors === "object") {
    const selectorMap = step.selectors;
    if (selectorMap.css) addSelector(out, selectorMap.css);
    if (selectorMap.id) addSelector(out, `id=${selectorMap.id}`);
    if (selectorMap.name) addSelector(out, `name=${selectorMap.name}`);
    if (selectorMap.placeholder)
      addSelector(out, `placeholder=${selectorMap.placeholder}`);
    if (selectorMap.aria) addSelector(out, `aria/${selectorMap.aria}`);
    if (selectorMap.xpath) addSelector(out, `xpath/${selectorMap.xpath}`);
    if (selectorMap.testId) addSelector(out, `testId=${selectorMap.testId}`);
  }

  addSelector(out, step.selector);
  addSelector(out, step.target);

  selectorsFromTargets(step.targets).forEach((selector) =>
    addSelector(out, selector),
  );

  let candidates = dedupe(out);
  const hasSpecificAria = candidates.some(
    (selector) =>
      selector.startsWith("aria/") && !isGenericAriaSelector(selector),
  );
  if (hasSpecificAria) {
    candidates = candidates.filter(
      (selector) =>
        !selector.startsWith("aria/") || !isGenericAriaSelector(selector),
    );
  }

  return candidates;
}

async function findElementForSelectors(page, selectors) {
  for (const selector of selectors) {
    try {
      const handle = await page.$(selector);
      if (handle) {
        return { handle, selector };
      }
    } catch (err) {
      // Invalid selector or handler not available; try next one.
    }
  }
  return null;
}

async function captureFocusedSnapshot(page, focusStep) {
  const selectors = buildSelectorCandidates(focusStep);
  if (selectors.length === 0) return null;

  const match = await findElementForSelectors(page, selectors);
  if (!match) return null;

  const elementHandle = match.handle;
  let rootHandle = elementHandle;
  let containerHandle = null;
  try {
    containerHandle = await elementHandle.evaluateHandle((el) => {
      const selectors = [
        "form",
        "section",
        "main",
        "article",
        "[role='dialog']",
        "[role='alert']",
        "[role='form']",
        "[role='region']",
        "[role='table']",
        "[role='list']",
        "[role='grid']",
        "[aria-label]",
        "[aria-labelledby]",
        "[data-testid]",
        "[data-test-id]",
        "[data-qa]",
        "[data-cy]",
      ];
      return el.closest(selectors.join(",")) || el;
    });

    const containerElement = containerHandle.asElement();
    if (containerElement) {
      rootHandle = containerElement;
    } else {
      await containerHandle.dispose();
      containerHandle = null;
    }

    return await page.accessibility.snapshot({
      interestingOnly: false,
      root: rootHandle,
    });
  } finally {
    if (containerHandle && containerHandle !== rootHandle) {
      await containerHandle.dispose();
    }
    if (rootHandle && rootHandle !== elementHandle) {
      await rootHandle.dispose();
    }
    await elementHandle.dispose();
  }
}

/**
 * Capture a snapshot scoped to the main content area (<main> or [role="main"]).
 * Falls back to null if no main element is found.
 */
async function captureMainContentSnapshot(page) {
  try {
    const mainHandle = await page.$('main, [role="main"]');
    if (!mainHandle) return null;
    try {
      return await page.accessibility.snapshot({
        interestingOnly: false,
        root: mainHandle,
      });
    } finally {
      await mainHandle.dispose();
    }
  } catch (err) {
    return null;
  }
}

const PRUNE_MAX_DEPTH = 8;
const PRUNE_MAX_NODES = 500;

/**
 * Strip noise from an accessibility snapshot tree:
 * - Remove InlineTextBox nodes
 * - Remove role:"none" leaves with no name
 * - Limit tree depth
 * - Cap total nodes
 */
function pruneSnapshot(node, depth = 0) {
  if (!node || typeof node !== "object") return null;
  if (node.role === "InlineTextBox") return null;
  if (depth > PRUNE_MAX_DEPTH) return null;

  let pruned = { ...node };
  if (Array.isArray(node.children) && node.children.length > 0) {
    const kids = [];
    for (const child of node.children) {
      const p = pruneSnapshot(child, depth + 1);
      if (p) kids.push(p);
    }
    if (kids.length > 0) {
      pruned.children = kids;
    } else {
      delete pruned.children;
    }
  } else {
    delete pruned.children;
  }

  // Remove empty role:"none" / role:"generic" leaves with no name
  if (
    (pruned.role === "none" || pruned.role === "generic") &&
    !pruned.name &&
    !pruned.children
  ) {
    return null;
  }

  return pruned;
}

/** Walk a pruned tree and cap total nodes to PRUNE_MAX_NODES */
function capNodes(node) {
  let count = 0;
  function walk(n) {
    if (!n || count >= PRUNE_MAX_NODES) return null;
    count++;
    const out = { ...n };
    if (Array.isArray(n.children)) {
      const kids = [];
      for (const child of n.children) {
        if (count >= PRUNE_MAX_NODES) break;
        const c = walk(child);
        if (c) kids.push(c);
      }
      if (kids.length > 0) out.children = kids;
      else delete out.children;
    }
    return out;
  }
  return walk(node);
}

function buildFocusNames(step) {
  if (!step || typeof step !== "object") return [];
  if (step.action === "navigate" || step.action === "scroll") return [];
  const names = [];

  if (typeof step.description === "string") {
    names.push(step.description);
  }

  const selectors = buildSelectorCandidates(step);
  for (const selector of selectors) {
    if (selector.startsWith("aria/")) {
      const value = selector.slice(5);
      if (!isGenericAriaSelector(selector)) names.push(value);
    }
  }

  return dedupe(names);
}

function findSnapshotNodeByName(root, focusNames) {
  if (!root || !focusNames.length) return null;
  const normalizedNames = focusNames
    .map((name) => normalizeText(name))
    .filter(Boolean);
  if (!normalizedNames.length) return null;

  const matches = (node) => {
    const nodeName = normalizeText(node?.name || "");
    if (!nodeName) return false;
    return normalizedNames.some(
      (candidate) => nodeName === candidate || nodeName.includes(candidate),
    );
  };

  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (matches(current)) return current;
    const children = Array.isArray(current.children) ? current.children : [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i]);
    }
  }
  return null;
}

async function captureAriaSnapshot(page, prefix, testCaseId, options = {}) {
  const snapshotPath = buildAriaSnapshotPath(prefix, testCaseId);
  const dir = path.dirname(snapshotPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let snapshot = null;
  let focused = false;

  // 1. Try element-level focused snapshot from the step selector
  if (options.focusStep) {
    try {
      snapshot = await captureFocusedSnapshot(page, options.focusStep);
      focused = !!snapshot;
    } catch (err) {
      snapshot = null;
      focused = false;
    }
  }

  // 2. If focused snapshot failed, try to find the node by name in a main-scoped snapshot
  if (!snapshot && options.focusStep) {
    const mainSnapshot = await captureMainContentSnapshot(page);
    if (mainSnapshot) {
      const focusNames = buildFocusNames(options.focusStep);
      const focusedNode = findSnapshotNodeByName(mainSnapshot, focusNames);
      if (focusedNode) {
        snapshot = focusedNode;
        focused = true;
      } else {
        // Use main content area instead of full page
        snapshot = mainSnapshot;
        focused = true;
      }
    }
  }

  // 3. If still nothing, try main content snapshot without name search
  if (!snapshot) {
    const mainSnapshot = await captureMainContentSnapshot(page);
    if (mainSnapshot) {
      snapshot = mainSnapshot;
    }
  }

  // 4. Last resort: full page snapshot
  if (!snapshot) {
    snapshot = await page.accessibility.snapshot({
      interestingOnly: false,
    });
  }

  if (!snapshot) {
    throw new Error("Accessibility snapshot was empty");
  }

  // Prune noise and cap size before writing
  snapshot = pruneSnapshot(snapshot);
  if (snapshot) snapshot = capNodes(snapshot);
  if (!snapshot) {
    throw new Error("Accessibility snapshot was empty after pruning");
  }

  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(
    `${CYAN}[Snapshot]${RESET} ARIA snapshot captured (${focused ? "focused" : "main"}): ${CYAN}${snapshotPath}${RESET}`,
  );
  return snapshotPath;
}

async function captureVisualScreenshot(page, prefix, testCaseId) {
  const screenshotsDir = path.join(__dirname, "screenshots");
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }
  const screenshotPath = path.join(
    screenshotsDir,
    `screenshot_${prefix}_${testCaseId}_${Date.now()}.png`,
  );
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(
      `${CYAN}[Screenshot]${RESET} Visual screenshot captured: ${CYAN}${screenshotPath}${RESET}`,
    );
    return screenshotPath;
  } catch (err) {
    console.warn(`Failed to capture visual screenshot: ${err.message}`);
    return null;
  }
}

async function getFailedStepIndex(executionId) {
  if (!executionId) return null;
  try {
    const stepRes = await fetch(
      `${BACKEND_URL}/api/executions/${executionId}/steps`,
    );
    if (stepRes.ok) {
      const steps = await stepRes.json();
      const failed = Array.isArray(steps)
        ? steps.find((s) => s.status === "failed")
        : null;
      if (failed && Number.isFinite(Number(failed.step_index))) {
        return Number(failed.step_index);
      }
    }
  } catch (err) {
    // ignore and fall back
  }

  try {
    const reportRes = await fetch(
      `${BACKEND_URL}/api/executions/${executionId}/report`,
    );
    if (reportRes.ok) {
      const reports = await reportRes.json();
      const failed = Array.isArray(reports)
        ? reports.find((r) => r.type === "error")
        : null;
      if (failed && Number.isFinite(Number(failed.step_index))) {
        return Number(failed.step_index);
      }
    }
  } catch (err) {
    // ignore and fall back
  }

  return null;
}

async function postFailureIfMissing({
  testCaseId,
  startTime,
  errorMessage,
  ariaSnapshotPath,
  lastStepIndex,
  lastStepLine,
}) {
  try {
    const execRes = await fetch(
      `${BACKEND_URL}/api/tests/${testCaseId}/executions`,
    );
    const executions = await execRes.json();
    const latest = executions && executions.length > 0 ? executions[0] : null;
    const hasRecent =
      latest && new Date(latest.created_at).getTime() > startTime;
    if (hasRecent) return;

    const snapshotUrl = ariaSnapshotPath
      ? `/aria-snapshots/${path.basename(ariaSnapshotPath)}`
      : null;
    const bugs =
      typeof lastStepIndex === "number"
        ? [
            {
              stepIndex: lastStepIndex,
              type: "error",
              message:
                lastStepLine || "Execution timed out while running this step",
            },
          ]
        : [];

    await fetch(`${BACKEND_URL}/api/tests/${testCaseId}/executions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "failed",
        duration: Date.now() - startTime,
        errorMessage,
        ariaSnapshotUrl: snapshotUrl,
        bugs,
      }),
    });

    // Also file a local bug report for parity
    try {
      const conn = await mysql.createConnection({
        socketPath: "/var/run/mysqld/mysqld.sock",
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD || "",
        database: process.env.DB_NAME || "test_recorder",
      });
      const [[test]] = await conn.execute(
        "SELECT name FROM tests WHERE id = ? LIMIT 1",
        [testCaseId],
      );
      if (test) {
        await file_bug(test.name, errorMessage, ariaSnapshotPath);
      } else {
        await file_bug(`Test ${testCaseId}`, errorMessage, ariaSnapshotPath);
      }
      await conn.end();
    } catch (dbErr) {
      console.warn(
        "Failed to lookup test name for local bug report:",
        dbErr.message,
      );
      await file_bug(`Test ${testCaseId}`, errorMessage, ariaSnapshotPath);
    }
  } catch (err) {
    console.warn("Failed to post timeout failure:", err.message);
  }
}

async function executeTestCase(browser, page, testCaseId) {
  const startTime = Date.now();
  const res = await fetch(`${BACKEND_URL}/api/test-cases/${testCaseId}`);
  if (!res.ok)
    throw new Error(`Failed to fetch test case ${testCaseId} from backend`);
  const testCase = await res.json();

  console.log(
    `Starting execution for flow: ${testCase.name} (ID: ${testCaseId})`,
  );

  page.on("console", (msg) => console.log(`PAGE CONSOLE: ${msg.text()}`));

  // Auto-handle file upload dialogs with a dummy test PDF
  const testUploadFile = path.resolve(__dirname, "test-upload.pdf");
  page.on("filechooser", async (fileChooser) => {
    console.log(
      `${CYAN}[Upload]${RESET} File chooser detected, uploading: ${testUploadFile}`,
    );
    try {
      await fileChooser.accept([testUploadFile]);
      console.log(`${GREEN}[Upload]${RESET} File uploaded successfully.`);
    } catch (err) {
      console.error(
        `${RED}[Upload]${RESET} File upload failed: ${err.message}`,
      );
    }
  });

  // Always re-find the worker to avoid "Execution context is not available" errors if it suspended
  const worker = await getWorker(browser);

  // Clear previous debug logs
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ e2e_debug_logs: [] });
  });

  // Start execution
  await worker.evaluate(async (tc) => {
    const log = async (msg) => {
      const { e2e_debug_logs = [] } =
        await chrome.storage.local.get("e2e_debug_logs");
      e2e_debug_logs.push(`[${new Date().toISOString()}] ${msg}`);
      await chrome.storage.local.set({ e2e_debug_logs });
    };

    await log("Worker: START_EXECUTION triggered");
    const tabs = await chrome.tabs.query({});
    const targetTab = tabs.find(
      (t) =>
        t.url &&
        (t.url.includes("localhost:3007") || t.url.includes("localhost:3000")),
    );

    if (!targetTab) {
      await log("Worker: Target tab not found!");
      return { error: "Target tab not found" };
    }

    await log(`Worker: Target tab ID ${targetTab.id}, URL: ${targetTab.url}`);

    if (typeof executeCurrentStep === "function") {
      executionState = {
        isRunning: true,
        tabId: targetTab.id,
        testId: tc.id,
        steps: tc.steps || [],
        currentIndex: 0,
        executingIndex: -1,
        waitingForNavigation: false,
        detectedBugs: [],
        startTime: Date.now(),
      };
      await log(
        `Worker: Starting engine with ${executionState.steps.length} steps`,
      );
      executeCurrentStep();
      return { success: true };
    } else {
      await log("Worker: executeCurrentStep NOT FOUND");
      return { error: "executeCurrentStep not found" };
    }
  }, testCase);

  // Monitor for completion and poll logs
  let attempts = 0;
  const pollIntervalMs = parseInt(
    process.env.E2E_POLL_INTERVAL_MS || "2000",
    10,
  );
  const maxAttempts = parseInt(process.env.E2E_MAX_POLL_ATTEMPTS || "90", 10); // 3 minutes
  const stepStallMs = parseInt(process.env.E2E_STEP_STALL_MS || "30000", 10); // 30s
  let lastLogIndex = 0;
  let lastStepIndex = null;
  let lastStepLine = null;
  let lastStepAt = Date.now();

  while (attempts < maxAttempts) {
    // Re-check worker for polling too
    let workerForPolling;
    try {
      workerForPolling = await getWorker(browser);
    } catch (e) {
      console.warn("Retrying worker connection for logs...");
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const resState = await workerForPolling
      .evaluate(async () => {
        const { execution_state_v2, e2e_debug_logs = [] } =
          await chrome.storage.local.get([
            "execution_state_v2",
            "e2e_debug_logs",
          ]);
        return { execution_state_v2, e2e_debug_logs };
      })
      .catch((err) => {
        // Context might have detached during evaluate
        return null;
      });

    const logs = resState ? resState.e2e_debug_logs : null;
    if (resState && resState.execution_state_v2) {
      const state = resState.execution_state_v2;
      console.log(
        `WORKER STATE: Index=${state.currentIndex}/${state.steps.length}, Running=${state.isRunning}, WaitNav=${state.waitingForNavigation}`,
      );
    }

    let foundFinishedLog = false;
    if (logs && logs.length > lastLogIndex) {
      for (let i = lastLogIndex; i < logs.length; i++) {
        console.log(`WORKER DEBUG: ${logs[i]}`);
        const stepMatch = logs[i].match(/Step\s+(\d+):\s*(.+)$/);
        if (stepMatch) {
          lastStepIndex = parseInt(stepMatch[1], 10) - 1;
          lastStepLine = stepMatch[2];
          lastStepAt = Date.now();
        }

        if (logs[i].includes("Flow execution finished: Success=true")) {
          foundFinishedLog = true;
        }
      }
      lastLogIndex = logs.length;
    }

    const execRes = await fetch(
      `${BACKEND_URL}/api/tests/${testCaseId}/executions`,
    );
    const executions = await execRes.json();
    const latest = executions[0];

    // ONBOARDING: Interactive Phase Logic (Simulated)
    if (testCase.name.toLowerCase().includes("onboarding")) {
      const aiMsg = await get_last_ai_message(page);
      if (aiMsg && aiMsg.includes("?")) {
        const answer = get_answer_for_question(aiMsg);
        console.log(
          `[Onboarding] AI asked: "${aiMsg}" -> Answering: "${answer}"`,
        );
      }
    }

    // Check for success/failure with timing buffer for clock skew
    if (latest && new Date(latest.created_at).getTime() > startTime - 10000) {
      if (latest.status === "success") {
        console.log(
          `${GREEN}${BOLD}Execution of ${testCase.name} Successful (from DB)!${RESET}`,
        );

        // Capture final snapshot even on success from DB
        try {
          const successFocusStep =
            typeof lastStepIndex === "number"
              ? testCase.steps?.[lastStepIndex]
              : null;
          const ariaSnapshotPath = await captureAriaSnapshot(
            page,
            "success",
            testCaseId,
            successFocusStep ? { focusStep: successFocusStep } : {},
          );
          const snapshotUrl = `/aria-snapshots/${path.basename(ariaSnapshotPath)}`;

          await fetch(`${BACKEND_URL}/api/executions/${latest.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ariaSnapshotUrl: snapshotUrl }),
          }).catch((err) =>
            console.warn(
              "Failed to patch successful execution with ARIA snapshot:",
              err.message,
            ),
          );
        } catch (snapshotErr) {
          console.warn(
            "Failed to capture success ARIA snapshot:",
            snapshotErr.message,
          );
        }

        return true;
      } else if (latest.status === "failed") {
        const errorMsg = latest.error_message || "Unknown error";
        console.log(
          `${RED}${BOLD}Execution of ${testCase.name} Failed (from DB): ${errorMsg}${RESET}`,
        );

        let ariaSnapshotPath = null;
        const failedStepIndex = await getFailedStepIndex(latest.id);
        const focusStepIndex =
          Number.isFinite(failedStepIndex) && failedStepIndex >= 0
            ? failedStepIndex
            : lastStepIndex;
        const focusStep =
          typeof focusStepIndex === "number"
            ? testCase.steps?.[focusStepIndex]
            : null;
        try {
          await captureVisualScreenshot(page, "error", testCaseId);
          ariaSnapshotPath = await captureAriaSnapshot(
            page,
            "error",
            testCaseId,
            focusStep ? { focusStep } : {},
          );
          await file_bug(testCase.name, errorMsg, ariaSnapshotPath);

          const snapshotUrl = `/aria-snapshots/${path.basename(ariaSnapshotPath)}`;
          await fetch(`${BACKEND_URL}/api/executions/${latest.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ariaSnapshotUrl: snapshotUrl }),
          }).catch((err) =>
            console.warn(
              "Failed to patch execution with ARIA snapshot:",
              err.message,
            ),
          );
        } catch (snapshotErr) {
          console.error(
            "Failed to capture ARIA snapshot:",
            snapshotErr.message,
          );
          await file_bug(testCase.name, errorMsg, null);
        }

        throw new Error(
          `Execution of ${testCase.name} Failed. Error: ${errorMsg}. Duration: ${latest.duration}ms`,
        );
      }
    }

    if (foundFinishedLog) {
      console.log(
        `${GREEN}${BOLD}Execution of ${testCase.name} Successful (from Logs)!${RESET}`,
      );

      // Capture final snapshot even on success
      try {
        const successFocusStep =
          typeof lastStepIndex === "number"
            ? testCase.steps?.[lastStepIndex]
            : null;
        const ariaSnapshotPath = await captureAriaSnapshot(
          page,
          "success",
          testCaseId,
          successFocusStep ? { focusStep: successFocusStep } : {},
        );
        const snapshotUrl = `/aria-snapshots/${path.basename(ariaSnapshotPath)}`;

        // Fetch latest to get ID for patching
        const execRes = await fetch(
          `${BACKEND_URL}/api/tests/${testCaseId}/executions`,
        );
        const executions = await execRes.json();
        const latest = executions[0];

        if (latest && latest.id) {
          await fetch(`${BACKEND_URL}/api/executions/${latest.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ariaSnapshotUrl: snapshotUrl }),
          }).catch((err) =>
            console.warn(
              "Failed to patch successful execution with ARIA snapshot:",
              err.message,
            ),
          );
        }
      } catch (snapshotErr) {
        console.warn(
          "Failed to capture success ARIA snapshot:",
          snapshotErr.message,
        );
      }

      return true;
    }

    // Fast-fail if we stall on the same step for too long
    if (lastStepAt && Date.now() - lastStepAt > stepStallMs) {
      const stallMessage = `Step ${typeof lastStepIndex === "number" ? lastStepIndex + 1 : "?"} stalled for ${Math.round(stepStallMs / 1000)}s: ${lastStepLine || "No step details"}`;
      let ariaSnapshotPath = null;
      const focusStep =
        typeof lastStepIndex === "number"
          ? testCase.steps?.[lastStepIndex]
          : null;
      try {
        await captureVisualScreenshot(page, "stall", testCaseId);
        ariaSnapshotPath = await captureAriaSnapshot(
          page,
          "stall",
          testCaseId,
          focusStep ? { focusStep } : {},
        );
      } catch (err) {
        console.warn("Failed to capture stall ARIA snapshot:", err.message);
        ariaSnapshotPath = null;
      }

      if (ariaSnapshotPath) {
        console.log(
          `[Stall Debug] ARIA snapshot for stall: ${ariaSnapshotPath}`,
        );
      }

      await postFailureIfMissing({
        testCaseId,
        startTime,
        errorMessage: stallMessage,
        ariaSnapshotPath,
        lastStepIndex,
        lastStepLine,
      });

      throw new Error(`Execution stalled: ${stallMessage}`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
    attempts++;
  }

  const totalWaitMs = maxAttempts * pollIntervalMs;
  const timeoutMessage = `Execution of ${testCase.name} Timed Out after ${Math.round(totalWaitMs / 1000)}s`;

  let ariaSnapshotPath = null;
  const focusStep =
    typeof lastStepIndex === "number" ? testCase.steps?.[lastStepIndex] : null;
  try {
    await captureVisualScreenshot(page, "timeout", testCaseId);
    ariaSnapshotPath = await captureAriaSnapshot(
      page,
      "timeout",
      testCaseId,
      focusStep ? { focusStep } : {},
    );
  } catch (err) {
    console.warn("Failed to capture timeout ARIA snapshot:", err.message);
    ariaSnapshotPath = null;
  }

  await postFailureIfMissing({
    testCaseId,
    startTime,
    errorMessage: timeoutMessage,
    ariaSnapshotPath,
    lastStepIndex,
    lastStepLine,
  });

  throw new Error(timeoutMessage);
}

async function runE2E() {
  console.log("Starting Daily E2E Run...");
  await cleanupUser(TEST_EMAIL);

  // Use existing Chrome profile to preserve login session
  // Set USE_CHROME_PROFILE=0 to use a fresh browser
  const useExistingProfile = process.env.USE_CHROME_PROFILE !== "0";

  let launchArgs = [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--start-maximized",
  ];

  if (useExistingProfile) {
    // Use a separate test profile directory to avoid Chrome lock conflicts
    const testProfileDir = path.join(__dirname, ".chrome-test-profile");
    const sourceProfile = path.join(
      process.env.HOME,
      ".config/google-chrome/Default",
    );

    // Copy cookies and login data from main Chrome profile
    if (!fs.existsSync(testProfileDir)) {
      fs.mkdirSync(testProfileDir, { recursive: true });
    }

    // Copy essential files for login persistence
    const filesToCopy = [
      "Cookies",
      "Login Data",
      "Web Data",
      "Preferences",
      "Local Storage",
      "Extension State",
      "Service Worker",
      "Network Persistent State",
      "Extension Cookies",
    ];
    for (const file of filesToCopy) {
      const src = path.join(sourceProfile, file);
      const dest = path.join(testProfileDir, file);
      if (fs.existsSync(src)) {
        try {
          const stats = fs.statSync(src);
          if (stats.isDirectory()) {
            fs.cpSync(src, dest, { recursive: true });
          } else {
            fs.copyFileSync(src, dest);

            // Also copy companion files for SQLite
            for (const suffix of ["-journal", "-wal"]) {
              const journalSrc = src + suffix;
              const journalDest = dest + suffix;
              if (fs.existsSync(journalSrc)) {
                fs.copyFileSync(journalSrc, journalDest);
              }
            }
          }
          console.log(`Copied ${file} (and journals) to test profile`);
        } catch (e) {
          console.warn(`Could not copy ${file}: ${e.message}`);
        }
      }
    }

    console.log(`Using copied Chrome profile from: ${sourceProfile}`);
    launchArgs.push(`--user-data-dir=${testProfileDir}`);
  } else {
    console.log(
      "Using fresh browser (no profile). Set USE_CHROME_PROFILE=1 to use saved login.",
    );
  }

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: launchArgs,
  });

  try {
    const pages = await browser.pages();
    const page = pages[0];

    console.log(`Navigating to ${TARGET_URL}...`);
    try {
      await page.goto(TARGET_URL, { waitUntil: "load", timeout: 60000 });
    } catch (err) {
      console.error(`Initial navigation failed: ${err.message}`);
      let ariaSnapshotPath = null;
      try {
        await captureVisualScreenshot(page, "system_error", "system");
        ariaSnapshotPath = await captureAriaSnapshot(
          page,
          "system_error",
          "system",
        );
      } catch (snapshotErr) {
        console.warn(
          "Failed to capture system ARIA snapshot:",
          snapshotErr.message,
        );
      }

      // Try to report this as a general failure if we have a main test ID
      const mainTestId = process.env.E2E_MAIN_TEST_ID?.split(",")[0];
      if (mainTestId) {
        const snapshotUrl = ariaSnapshotPath
          ? `/aria-snapshots/${path.basename(ariaSnapshotPath)}`
          : null;
        await fetch(`${BACKEND_URL}/api/tests/${mainTestId}/executions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "failed",
            errorMessage: `System Navigation Error: ${err.message}`,
            ariaSnapshotUrl: snapshotUrl,
          }),
        }).catch(() => {});
      }
      throw err;
    }

    // Initial worker check
    await getWorker(browser);
    console.log("Extension background worker found.");

    await new Promise((r) => setTimeout(r, 5000));

    // Dynamic Lookup removed to prevent running old tests by accident
    // We strictly use the .env IDs now.
    const loginTestId = process.env.E2E_LOGIN_TEST_ID;
    if (loginTestId) {
      console.log(`Running Direct Login Flow (ID: ${loginTestId})...`);
      await executeTestCase(browser, page, loginTestId);
      await new Promise((r) => setTimeout(r, 5000));
    }

    const onboardingTestId = process.env.E2E_ONBOARDING_TEST_ID;
    if (onboardingTestId) {
      console.log(`Running Onboarding Flow (ID: ${onboardingTestId})...`);
      await executeTestCase(browser, page, onboardingTestId);
      await new Promise((r) => setTimeout(r, 5000));
    }

    let testIds = [];
    const suiteId = process.env.E2E_SUITE_ID;
    const mainTestId = process.env.E2E_MAIN_TEST_ID;

    if (suiteId) {
      console.log(`Fetching tests for Suite ID: ${suiteId}...`);
      const res = await fetch(`${BACKEND_URL}/api/suites/${suiteId}/tests`);
      if (!res.ok) throw new Error(`Failed to fetch suite ${suiteId}`);
      const tests = await res.json();
      testIds = tests.map((t) => t.id);
    } else if (mainTestId) {
      testIds = mainTestId.split(",").map((id) => id.trim());
    }

    if (testIds.length === 0) {
      const listRes = await fetch(`${BACKEND_URL}/api/test-cases`);
      const testCases = await listRes.json();
      const filteredCases = testCases.filter(
        (tc) => String(tc.id) !== String(loginTestId),
      );
      if (filteredCases.length > 0) {
        testIds = [filteredCases[0].id];
      }
    }

    console.log(`Planned execution: ${testIds.length} flows.`);
    const results = [];

    for (let flowIdx = 0; flowIdx < testIds.length; flowIdx++) {
      const id = testIds[flowIdx];
      console.log(`\n=== Starting Flow ID: ${id} ===`);

      // Reset extension execution state before each flow to prevent stale tabId / timers
      try {
        const worker = await getWorker(browser);
        await worker.evaluate(async () => {
          if (typeof executionState !== "undefined") {
            if (executionState.stepTimeout) {
              clearTimeout(executionState.stepTimeout);
              executionState.stepTimeout = null;
            }
            executionState = {
              isRunning: false,
              tabId: null,
              steps: [],
              currentIndex: 0,
              waitingForNavigation: false,
              stepResults: [],
              testId: null,
              startTime: null,
            };
            await chrome.storage.local.set({
              execution_state_v2: executionState,
            });
          }
          await chrome.storage.local.set({ e2e_debug_logs: [] });
        });
      } catch (resetErr) {
        console.warn(
          `Failed to reset worker state before flow ${id}: ${resetErr.message}`,
        );
      }

      // Discover flow's starting URL if applicable
      let flowStartUrl = TARGET_URL;
      try {
        const testCaseRes = await fetch(`${BACKEND_URL}/api/test-cases/${id}`);
        if (testCaseRes.ok) {
          const testCaseData = await testCaseRes.json();
          if (
            testCaseData.steps &&
            testCaseData.steps.length > 0 &&
            testCaseData.steps[0].url
          ) {
            flowStartUrl = testCaseData.steps[0].url;
          }
        }
      } catch (e) {
        console.warn(
          `Failed to fetch test case ${id} starting URL: ${e.message}`,
        );
      }

      // Navigate back to the flow's starting URL so each flow starts from a clean page
      try {
        const currentUrl = page.url();
        if (
          !currentUrl ||
          !currentUrl.includes("localhost:3007") ||
          currentUrl !== flowStartUrl
        ) {
          console.log(
            `Navigating to starting URL ${flowStartUrl} before flow ${id}...`,
          );
          await page.goto(flowStartUrl, { waitUntil: "load", timeout: 60000 });
          await new Promise((r) => setTimeout(r, 3000)); // Let page settle
        }
      } catch (navErr) {
        console.warn(
          `Navigation to starting URL before flow ${id} failed: ${navErr.message}`,
        );
      }

      try {
        await executeTestCase(browser, page, id);
        results.push({ id, status: "SUCCESS" });
        console.log(`${GREEN}${BOLD}=== Flow ${id}: SUCCESS ===${RESET}`);
      } catch (err) {
        console.error(
          `${RED}${BOLD}ERROR in Flow ${id}: ${err.message}${RESET}`,
        );
        results.push({ id, status: "FAILED", error: err.message });
        // If it's a login flow failure, we should probably stop the whole thing
        if (String(id) === String(loginTestId)) {
          console.error("Login failed. Skipping remaining tests.");
          break;
        }
      }

      // Wait between flows to let browser settle
      if (flowIdx < testIds.length - 1) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    console.log("\n" + "=".repeat(30));
    console.log("E2E RUN SUMMARY");
    console.log("=".repeat(30));
    results.forEach((r) => {
      const color = r.status === "SUCCESS" ? GREEN : RED;
      console.log(
        `${color}${BOLD}Flow ${r.id}: ${r.status}${r.error ? ` (${r.error})` : ""}${RESET}`,
      );
    });
    console.log("=".repeat(30));

    if (results.some((r) => r.status === "FAILED")) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`${RED}${BOLD}CRITICAL E2E ERROR: ${err.message}${RESET}`);
    process.exit(1);
  } finally {
    await new Promise((r) => setTimeout(r, 5000));
    await browser.close();
  }
}

runE2E();

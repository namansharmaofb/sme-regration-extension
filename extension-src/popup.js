// Popup logic: panel-style UI, start/stop recording and send test case to backend

const API_BASE_URL = "http://localhost:4000"; // adjust if needed

const recordBtn = document.getElementById("recordBtn");
const statusText = document.getElementById("statusText");
const agentStatus = document.getElementById("agentStatus");
const runningFlowEl = document.getElementById("runningFlow");
const firstFailureEl = document.getElementById("firstFailure");
const logRunningFlowEl = document.getElementById("logRunningFlow");
const logFirstFailureEl = document.getElementById("logFirstFailure");
const testNameInput = document.getElementById("testName");
const flowSelect = document.getElementById("flowSelect");
const newFlowBtn = document.getElementById("newFlowBtn");
const saveFlowBtn = document.getElementById("saveFlowBtn");
const deleteFlowBtn = document.getElementById("deleteFlowBtn");
const runFlowBtn = document.getElementById("runFlowBtn");
const stopExecutionBtn = document.getElementById("stopExecutionBtn");
const logsEl = document.getElementById("logs");

const editCommand = document.getElementById("editCommand");
const editTarget = document.getElementById("editTarget");
const editValue = document.getElementById("editValue");
const editDescription = document.getElementById("editDescription");
const findBtn = document.getElementById("findBtn");
const deleteStepBtn = document.getElementById("deleteStepBtn");
const moveUpBtn = document.getElementById("moveUpBtn");
const moveDownBtn = document.getElementById("moveDownBtn");
const stepsBody = document.getElementById("stepsBody");
const exportCodeBtn = document.getElementById("exportCodeBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const uploadJsonBtn = document.getElementById("uploadJsonBtn");
const jsonInput = document.getElementById("jsonInput");
const backendDot = document.getElementById("backendDot");
const backendText = document.getElementById("backendText");
const popoutBtn = document.getElementById("popoutBtn");

let currentSteps = [];
let executionActiveIndex = -1;
let selectedStepIndex = -1;
let currentRunningFlowName = "";
let firstFailureMessage = "";

function setRunningFlow(text) {
  const value = text && text.length > 0 ? text : "-";
  if (runningFlowEl) runningFlowEl.textContent = value;
  if (logRunningFlowEl) logRunningFlowEl.textContent = value;
}

function setFirstFailure(text) {
  const value = text && text.length > 0 ? text : "-";
  if (firstFailureEl) firstFailureEl.textContent = value;
  if (logFirstFailureEl) logFirstFailureEl.textContent = value;
}

function resetFailureStatus() {
  firstFailureMessage = "";
  setFirstFailure("-");
}

function extractStepIndexFromMessage(message) {
  if (!message || typeof message !== "string") return null;
  const match =
    message.match(/step\s*:?(\d+)/i) || message.match(/step\s+(\d+)/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isFinite(num) ? num : null;
}

const commandRefData = {
  click: "Clicks on an element (button, link, etc.).",
  input: "Types text into an input field or textarea.",
  navigate: "Opens the specified URL.",
  assertText: "Verifies that an element contains the expected text.",
  assertExists: "Verifies that an element is present on the page.",
  scroll: "Scrolls the window to the specified X, Y coordinates.",
  wait: "Pauses execution for a specified duration (ms).",
};

function logLine(text, level = "info") {
  const ts = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const entry = document.createElement("div");
  entry.className = `log-entry log-${level}`;

  const tsSpan = document.createElement("span");
  tsSpan.className = "ts";
  tsSpan.textContent = ts;

  const msgSpan = document.createElement("span");
  msgSpan.textContent = text;

  entry.appendChild(tsSpan);
  entry.appendChild(msgSpan);

  logsEl.appendChild(entry);
  logsEl.scrollTop = logsEl.scrollHeight;
}

function renderSteps(steps = []) {
  currentSteps = steps;
  stepsBody.innerHTML = "";
  if (!steps.length) {
    const row = document.createElement("tr");
    row.className = "steps-empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "steps-empty";
    cell.textContent = "No steps recorded yet.";
    row.appendChild(cell);
    stepsBody.appendChild(row);
    updateEditPanel(null);
    return;
  }

  steps.forEach((step, index) => {
    const row = document.createElement("tr");
    if (selectedStepIndex === index) row.classList.add("selected-row");
    if (executionActiveIndex === index) row.classList.add("active-step-row");

    row.onclick = () => {
      selectedStepIndex = index;
      renderSteps(currentSteps);
      updateEditPanel(step);
    };

    const idx = document.createElement("td");
    idx.textContent = String(index + 1);
    idx.style.padding = "6px";

    const cmd = document.createElement("td");
    cmd.textContent = step.action || "";
    cmd.style.padding = "6px";

    const target = document.createElement("td");
    target.textContent = step.selector || step.target || "";
    target.style.padding = "6px";
    target.style.maxWidth = "120px";
    target.style.overflow = "hidden";
    target.style.textOverflow = "ellipsis";
    target.style.whiteSpace = "nowrap";
    target.title = step.selector || step.target || "";

    const value = document.createElement("td");
    value.textContent = step.value || "";
    value.style.padding = "6px";

    row.appendChild(idx);
    row.appendChild(cmd);
    row.appendChild(target);
    row.appendChild(value);
    stepsBody.appendChild(row);
  });

  // If we have a selection, ensure it's loaded in panel
  if (selectedStepIndex >= 0 && selectedStepIndex < steps.length) {
    updateEditPanel(steps[selectedStepIndex]);
  }
}

function updateEditPanel(step) {
  if (!step) {
    editCommand.value = "click";
    editTarget.value = "";
    editValue.value = "";
    editDescription.value = "";
    return;
  }

  editCommand.value = step.action || step.command || "click";
  editTarget.value = step.selector || step.target || "";
  editValue.value = step.value || "";
  editDescription.value = step.description || "";

  // Update reference tab
  const ref = commandRefData[editCommand.value] || "No reference available.";
  document.getElementById("commandRef").textContent = ref;
}

// Bind Edit Panel Inputs
[editCommand, editTarget, editValue, editDescription].forEach((el) => {
  el.oninput = () => {
    if (selectedStepIndex === -1 || !currentSteps[selectedStepIndex]) return;

    const step = currentSteps[selectedStepIndex];
    const field = el.id.replace("edit", "").toLowerCase();

    if (el.id === "editCommand") {
      step.action = el.value;
      step.command = el.value;
      // Update reference immediately
      document.getElementById("commandRef").textContent =
        commandRefData[el.value] || "";
    } else if (el.id === "editTarget") {
      step.selector = el.value;
      step.target = el.value;
      if (step.selectors) {
        // Update the primary selector in the structured targets as well
        if (step.selectors.targets && step.selectors.targets.length > 0) {
          step.selectors.targets[0].value = el.value;
        } else {
          step.selectors.targets = [
            { type: step.selectorType || "css", value: el.value },
          ];
        }
        step.selectors.selector = el.value;
      }
    } else if (el.id === "editValue") {
      step.value = el.value;
    } else if (el.id === "editDescription") {
      step.description = el.value;
    }

    // Debounce or just sync? Let's sync on change/blur for performance
  };

  el.onblur = () => {
    renderSteps(currentSteps); // Refresh table text
    syncStepsToBackground();
  };
});

// Management Buttons
deleteStepBtn.onclick = () => {
  if (selectedStepIndex === -1) return;
  if (confirm(`Delete step ${selectedStepIndex + 1}?`)) {
    currentSteps.splice(selectedStepIndex, 1);
    selectedStepIndex = -1;
    renderSteps(currentSteps);
    syncStepsToBackground();
    logLine("Step deleted", "info");
  }
};

moveUpBtn.onclick = () => {
  if (selectedStepIndex <= 0) return;
  const temp = currentSteps[selectedStepIndex];
  currentSteps[selectedStepIndex] = currentSteps[selectedStepIndex - 1];
  currentSteps[selectedStepIndex - 1] = temp;
  selectedStepIndex--;
  renderSteps(currentSteps);
  syncStepsToBackground();
};

moveDownBtn.onclick = () => {
  if (selectedStepIndex === -1 || selectedStepIndex >= currentSteps.length - 1)
    return;
  const temp = currentSteps[selectedStepIndex];
  currentSteps[selectedStepIndex] = currentSteps[selectedStepIndex + 1];
  currentSteps[selectedStepIndex + 1] = temp;
  selectedStepIndex++;
  renderSteps(currentSteps);
  syncStepsToBackground();
};

// Find Button: Highlight element on page
findBtn.onclick = async () => {
  const target = editTarget.value.trim();
  if (!target) return;

  logLine(`Finding element: ${target}`, "info");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.scripting
    .executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (selector) => {
        let el = null;
        try {
          el = document.querySelector(selector);
        } catch (e) {}

        if (!el) {
          // Try XPath if CSS fails
          try {
            const result = document.evaluate(
              selector,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            );
            el = result.singleNodeValue;
          } catch (e) {}
        }

        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          const originalOutline = el.style.outline;
          el.style.outline = "4px solid #3b82f6";
          el.style.outlineOffset = "2px";
          setTimeout(() => {
            el.style.outline = originalOutline;
          }, 2000);
          return true;
        }
        return false;
      },
      args: [target],
    })
    .then((results) => {
      const found = results.some((r) => r.result);
      if (!found) {
        logLine(`Element not found: ${target}`, "error");
      } else {
        logLine(`Element highlighted on page`, "success");
      }
    });
};

// Tab Logic
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");

    const isLog = tab.dataset.tab === "log";
    const isRef = tab.dataset.tab === "ref";
    const isBugs = tab.dataset.tab === "bugs";
    const isHistory = tab.dataset.tab === "history";

    document.getElementById("logContent").style.display = isLog
      ? "flex"
      : "none";
    document.getElementById("refContent").style.display = isRef
      ? "block"
      : "none";
    document.getElementById("bugContent").style.display = isBugs
      ? "block"
      : "none";
    document.getElementById("historyContent").style.display = isHistory
      ? "block"
      : "none";

    // Load history or bugs when tab is opened
    if (isHistory) {
      loadExecutionHistory();
    } else if (isBugs) {
      loadBugs();
    }
  };
});

async function loadBugs() {
  const bugList = document.getElementById("bugList");
  const bugCountBadge = document.getElementById("bugCount");
  if (!bugList) return;

  try {
    bugList.innerHTML =
      '<div style="padding: 10px; text-align: center;">Loading bugs...</div>';

    const res = await fetch(`${API_BASE_URL}/api/bugs?limit=20`);
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);

    const bugs = await res.json();

    if (bugCountBadge) {
      bugCountBadge.textContent = bugs.length;
      bugCountBadge.style.display = bugs.length > 0 ? "inline-block" : "none";
    }

    if (bugs.length === 0) {
      bugList.innerHTML =
        '<div style="padding: 20px; text-align: center; color: #64748b;">No failed runs detected.</div>';
      return;
    }

    bugList.innerHTML = "";
    bugs.forEach((bug) => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.marginBottom = "8px";
      card.style.padding = "10px";
      card.style.borderColor = "#451a1a";
      card.style.background = "rgba(239, 68, 68, 0.05)";

      const date = new Date(bug.created_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      let snapshotLink = "";
      if (bug.aria_snapshot_url) {
        const fullUrl = `${API_BASE_URL}${bug.aria_snapshot_url}`;
        snapshotLink = `
          <div style="margin-top: 8px;">
            <a href="${fullUrl}" target="_blank" style="color: #60a5fa; text-decoration: none; font-size: 10px; display: flex; align-items: center; gap: 4px;">
              <span>📄 View ARIA Snapshot</span>
              <span style="font-size: 12px;">↗</span>
            </a>
          </div>
        `;
      }

      const errorMsg = bug.error_message || "Unknown execution failure";

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
          <span style="font-weight: 600; color: #f87171;">${bug.test_name} (ID: ${bug.test_id})</span>
          <span style="font-size: 9px; color: #64748b;">${date}</span>
        </div>
        <div style="color: #e5e7eb; font-size: 11px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;">${errorMsg}</div>
        ${snapshotLink}
      `;
      bugList.appendChild(card);
    });
  } catch (err) {
    console.error("Error loading bugs", err);
    bugList.innerHTML = `<div style="padding: 10px; color: #ef4444;">Error: ${err.message}</div>`;
  }
}

function syncStepsToBackground() {
  chrome.runtime
    .sendMessage({
      type: "RECORD_STEP", // Using RECORD_STEP as a sync mechanism or we need a new message type
      // Actually background keeps currentTestCase in memory.
      // We should probably have a SYNC_STEPS message.
      sync: true,
      steps: currentSteps,
    })
    .catch(() => {});
}

function moveStep(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= currentSteps.length) return;
  const temp = currentSteps[index];
  currentSteps[index] = currentSteps[newIndex];
  currentSteps[newIndex] = temp;
  renderSteps(currentSteps);
  logLine(`Moved step ${index + 1} to position ${newIndex + 1}`);
}

function deleteStep(index) {
  if (confirm(`Delete step ${index + 1}?`)) {
    currentSteps.splice(index, 1);
    renderSteps(currentSteps);
    // Sync back to background if we are currently recording or have a currentTestCase?
    // For now, it just affects what is SAVED to the backend next.
    logLine(`Deleted step ${index + 1}`);
  }
}

function generatePuppeteerCode(testCase) {
  const { name, steps } = testCase;
  let code = `const puppeteer = require('puppeteer');\n\n`;
  code += `(async () => {\n`;
  code += `  console.log('Running flow: ${name}');\n`;
  code += `  const browser = await puppeteer.launch({ headless: false });\n`;
  code += `  const page = await browser.newPage();\n`;
  code += `  await page.setViewport({ width: 1280, height: 720 });\n\n`;

  for (const step of steps) {
    code += `  // Step: ${step.description || step.action}\n`;
    const selector =
      step.selector ||
      (step.selectors ? step.selectors.selector || step.selectors.css : null) ||
      step.target;
    const selectorType =
      step.selectorType ||
      (step.selectors ? step.selectors.selectorType : null) ||
      "css";

    let finalSelector = selector;
    if (selectorType === "aria" || (selector && selector.startsWith("aria/"))) {
      const ariaText = selector.replace(/^aria\//, "");
      const safeAria = ariaText.replace(/"/g, '\\"');
      finalSelector = `[aria-label="${safeAria}"]`;
    } else if (selectorType === "id") {
      finalSelector = `#${selector.replace(/^#/, "")}`;
    } else if (selectorType === "xpath" || selectorType.startsWith("xpath:")) {
      finalSelector = `xpath/${selector.replace(/^xpath=/, "")}`;
    } else if (selectorType === "testId")
      finalSelector = `[data-testid="${selector}"],[data-cy="${selector}"],[data-test-id="${selector}"],[data-qa="${selector}"]`;
    else if (selectorType === "placeholder")
      finalSelector = `[placeholder="${selector}"]`;
    else if (selectorType === "linkText") finalSelector = `text/${selector}`;
    else if (selectorType === "role") finalSelector = `aria/${selector}`;

    if (step.action === "navigate") {
      code += `  await page.goto('${step.url}', { waitUntil: 'networkidle2' });\n`;
    } else if (step.action === "click") {
      code += `  await page.waitForSelector('${finalSelector}');\n`;
      code += `  await page.click('${finalSelector}');\n`;
    } else if (step.action === "input") {
      code += `  await page.waitForSelector('${finalSelector}');\n`;
      code += `  await page.focus('${finalSelector}');\n`;
      code += `  await page.keyboard.type('${step.value || ""}');\n`;
    } else if (step.action === "assertText") {
      const expected = step.selectors?.innerText || step.description;
      code += `  await page.waitForSelector('${finalSelector}');\n`;
      code += `  const text = await page.$eval('${finalSelector}', el => el.innerText);\n`;
      code += `  if (!text.includes('${expected}')) throw new Error('Assertion failed: Expected "${expected}"');\n`;
    } else if (step.action === "assertExists") {
      code += `  await page.waitForSelector('${finalSelector}');\n`;
    } else if (step.action === "scroll") {
      try {
        const pos = JSON.parse(step.value || '{"x":0,"y":0}');
        code += `  await page.evaluate(() => window.scrollTo(${pos.x}, ${pos.y}));\n`;
      } catch (e) {
        code += `  // Failed to parse scroll value\n`;
      }
    }

    code += `  await new Promise(r => setTimeout(r, 500)); // Delay between steps\n\n`;
  }

  code += `  console.log('Flow completed successfully');\n`;
  code += `  // await browser.close();\n`;
  code += `})();`;
  return code;
}

function onExportCode() {
  const name = testNameInput.value.trim() || "flow";
  const testCase = {
    name,
    steps: currentSteps,
  };

  if (testCase.steps.length === 0) {
    logLine("No steps to export");
    return;
  }

  const code = generatePuppeteerCode(testCase);
  const blob = new Blob([code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/\s+/g, "_")}_test.js`;
  a.click();
  URL.revokeObjectURL(url);
  logLine(`Exported code for '${name}'`, "success");
}

function onExportJson() {
  const name = testNameInput.value.trim() || "flow";
  const testCase = {
    name,
    steps: currentSteps,
    exportedAt: new Date().toISOString(),
    version: "2.0",
  };

  if (testCase.steps.length === 0) {
    logLine("No steps to export");
    return;
  }

  const json = JSON.stringify(testCase, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/\s+/g, "_")}_recording.json`;
  a.click();
  URL.revokeObjectURL(url);
  logLine(`Downloaded JSON for '${name}'`, "success");
}

function onUploadJson() {
  jsonInput.click();
}

if (jsonInput) {
  jsonInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (!data.steps || !Array.isArray(data.steps)) {
          throw new Error("Invalid format: JSON must contain a 'steps' array.");
        }

        currentSteps = data.steps;
        if (data.name) {
          testNameInput.value = data.name;
        }

        renderSteps(currentSteps);

        // Update background test case
        chrome.runtime.sendMessage({
          type: "START_RECORDING", // Restarting recording context with the new name/steps
          name: data.name || "Uploaded Flow",
          steps: currentSteps,
          sync: true, // We will handle this in background too
        });

        // Delay sync to ensure background is ready
        setTimeout(() => syncStepsToBackground(), 200);

        logLine(
          `Loaded flow '${data.name || "Uploaded Flow"}' with ${currentSteps.length} steps.`,
          "success",
        );
      } catch (err) {
        logLine("Error loading JSON: " + err.message, "error");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });
}

async function checkBackendStatus() {
  try {
    const res = await fetch(`${API_BASE_URL}/health`);
    if (res.ok) {
      backendDot.className = "status-dot online";
      backendText.textContent = "ONLINE";
    } else {
      throw new Error();
    }
  } catch (e) {
    backendDot.className = "status-dot offline";
    backendText.textContent = "OFFLINE";
  }
}

function setUI(isRecording) {
  if (isRecording) {
    recordBtn.textContent = "■ Stop";
    recordBtn.classList.add("recording");
    statusText.textContent = "Recording... perform actions in the tab";
    agentStatus.textContent = "Recording";
  } else {
    recordBtn.textContent = "● Record";
    recordBtn.classList.remove("recording");
    statusText.textContent = "Idle";
    agentStatus.textContent = "Ready";
  }
}

function setExecutionUI(isRunning) {
  if (isRunning) {
    runFlowBtn.style.display = "none";
    stopExecutionBtn.style.display = "inline-block";
  } else {
    runFlowBtn.style.display = "inline-block";
    stopExecutionBtn.style.display = "none";
  }
}

async function loadFlowsFromBackend() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/test-cases`);
    if (!res.ok) throw new Error(`Backend responded with status ${res.status}`);
    const flows = await res.json();

    // Clear existing options except the first "Select Flow"
    if (flowSelect) {
      flowSelect.innerHTML = '<option value="">Select Flow</option>';

      flows.forEach((flow) => {
        const opt = document.createElement("option");
        opt.value = flow.id.toString();
        opt.textContent = `${flow.id} - ${flow.name}`;
        opt.dataset.flowId = flow.id.toString();
        flowSelect.appendChild(opt);
      });
    }

    // Store in Chrome storage for persistence
    await chrome.storage.local.set({ savedFlows: flows });

    logLine(`Loaded ${flows.length} flow(s) from backend`, "success");
  } catch (err) {
    console.error("Error loading flows", err);
    logLine("Error loading flows: " + err.message, "error");

    // Try to load from Chrome storage as fallback
    chrome.storage.local.get(["savedFlows"], (result) => {
      if (result.savedFlows && flowSelect) {
        flowSelect.innerHTML = '<option value="">Select Flow</option>';
        result.savedFlows.forEach((flow) => {
          const opt = document.createElement("option");
          opt.value = flow.id.toString();
          opt.textContent = `${flow.id} - ${flow.name}`;
          opt.dataset.flowId = flow.id.toString();
          flowSelect.appendChild(opt);
        });
        logLine(
          `Loaded ${result.savedFlows.length} flow(s) from local storage`,
          "info",
        );
      }
    });
  }
}

async function loadExecutionHistory() {
  const tbody = document.getElementById("historyTableBody");
  if (!tbody) {
    console.error("historyTableBody not found");
    return;
  }

  try {
    tbody.innerHTML =
      '<tr><td colspan="3" style="padding: 20px; text-align: center; color: #64748b;">Loading...</td></tr>';

    const res = await fetch(`${API_BASE_URL}/api/executions?limit=50`);
    if (!res.ok) throw new Error(`Backend responded with status ${res.status}`);

    const executions = await res.json();

    if (executions.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="3" style="padding: 20px; text-align: center; color: #64748b;">No runs yet</td></tr>';
      return;
    }

    tbody.innerHTML = "";

    executions.forEach((exec) => {
      const isSuccess = exec.status === "success";
      const statusColor = isSuccess ? "#22c55e" : "#ef4444";
      const statusBg = isSuccess
        ? "rgba(34, 197, 94, 0.1)"
        : "rgba(239, 68, 68, 0.1)";
      const statusText = isSuccess ? "Success" : "Failed";

      const date = new Date(exec.created_at);
      const timeStr = date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const row = document.createElement("tr");
      row.style.borderBottom = "1px solid #1e293b";

      let detailRow = "";
      if (exec.error_message || exec.aria_snapshot_url) {
        const fullUrl = exec.aria_snapshot_url
          ? `${API_BASE_URL}${exec.aria_snapshot_url}`
          : null;
        const snapshotLink = fullUrl
          ? `
          <div style="margin-top: 4px;">
            <a href="${fullUrl}" target="_blank" style="color: #60a5fa; text-decoration: none; font-size: 9px; display: inline-flex; align-items: center; gap: 2px;">
              <span>📄 View ARIA Snapshot</span>
              <span style="font-size: 10px;">↗</span>
            </a>
          </div>
        `
          : "";

        const msgStyle = isSuccess
          ? "color: #94a3b8; border-left: 2px solid #22c55e;"
          : "color: #fca5a5; border-left: 2px solid #ef4444;";

        detailRow = `
          <div style="margin-top: 4px; padding: 4px; background: rgba(255, 255, 255, 0.02); border-radius: 4px; ${msgStyle}">
             ${exec.error_message ? `<div style="font-size: 9px; line-height: 1.3; margin-bottom: 2px;">${exec.error_message}</div>` : ""}
             ${snapshotLink}
          </div>
        `;
      }

      row.innerHTML = `
        <td style="padding: 8px; color: #e5e7eb; vertical-align: top;">
          <div style="font-weight: 500;">${exec.test_name || "Unknown"}</div>
          <div style="font-size: 9px; color: #64748b;">Test ID: ${exec.test_id}</div>
          ${detailRow}
        </td>
        <td style="padding: 8px; text-align: center; vertical-align: top;">
          <span style="
            display: inline-block;
            padding: 2px 8px;
            border-radius: 999px;
            font-size: 10px;
            font-weight: 600;
            color: ${statusColor};
            background: ${statusBg};
          ">${statusText}</span>
        </td>
        <td style="padding: 8px; color: #94a3b8; font-size: 10px; text-align: right; vertical-align: top;">
          ${timeStr}
        </td>
      `;
      tbody.appendChild(row);
    });
  } catch (err) {
    console.error("Error loading execution history", err);
    tbody.innerHTML = `<tr><td colspan="3" style="padding: 20px; text-align: center; color: #ef4444;">Error: ${err.message}</td></tr>`;
  }
}

function init() {
  // Load flows from backend first
  checkBackendStatus();
  loadFlowsFromBackend();
  loadBugs(); // Initial bug load to show badge

  // Re-check status every 10s
  setInterval(checkBackendStatus, 10000);

  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      logLine(
        `Error fetching state: ${chrome.runtime.lastError.message}`,
        "error",
      );
      return;
    }
    const { isRecording, currentTestCase, isRunning, currentIndex } =
      response || {};
    if (currentTestCase && currentTestCase.name) {
      testNameInput.value = currentTestCase.name;
    }
    currentSteps = currentTestCase?.steps || [];
    executionActiveIndex = isRunning ? currentIndex || 0 : -1;
    renderSteps(currentSteps);
    setUI(!!isRecording);
    setExecutionUI(!!isRunning);
  });
}

async function sendToBackend(testCase) {
  try {
    logLine("Sending test case to backend...");
    const res = await fetch(`${API_BASE_URL}/api/test-cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testCase),
    });

    if (!res.ok) {
      throw new Error(`Backend responded with status ${res.status}`);
    }

    const data = await res.json();
    statusText.textContent = "Saved to backend (id: " + data.id + ")";
    logLine(
      `Saved test case '${testCase.name}' with id=${data.id} (${data.stepCount} steps) to database`,
      "success",
    );

    // Store full test case in Chrome storage for offline access
    await chrome.storage.local.set({ [`flow_${data.id}`]: testCase });

    // Reload flows dropdown after saving
    await loadFlowsFromBackend();
  } catch (err) {
    console.error("Error sending to backend", err);
    statusText.textContent = "Error sending to backend: " + err.message;
    logLine("Error sending to backend: " + err.message, "error");
  }
}

function onRecordClick() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (!state) return;
    const currentlyRecording = state.isRecording;

    if (!currentlyRecording) {
      const nameFromInput = testNameInput.value.trim();
      let selectedFlowName = nameFromInput;

      if (!selectedFlowName && flowSelect && flowSelect.value) {
        // If user selected a flow from dropdown, reuse that name (overwrite)
        selectedFlowName = flowSelect.options[flowSelect.selectedIndex].text;
      }

      if (!selectedFlowName) {
        // Auto-generate unique name
        const now = new Date();
        // Format: Flow HH:MM:SS
        const timeString = now.toLocaleTimeString([], { hour12: false });
        selectedFlowName = `Flow ${timeString}`;
      }

      testNameInput.value = selectedFlowName;

      setUI(true);
      renderSteps([]);
      chrome.runtime.sendMessage(
        { type: "START_RECORDING", name: selectedFlowName },
        (res) => {
          if (!res || !res.success) {
            setUI(false);
            logLine("Error: Failed to start recording", "error");
          } else {
            logLine(`Started recording flow '${selectedFlowName}'`, "info");
          }
        },
      );
    } else {
      chrome.runtime.sendMessage({ type: "STOP_RECORDING" }, async (res) => {
        if (res && res.success) {
          setUI(false);
          const testCase = res.testCase || {};
          if (!testCase.name) {
            const now = new Date();
            const timeString = now.toLocaleTimeString([], { hour12: false });
            testCase.name =
              testNameInput.value.trim() ||
              (flowSelect && flowSelect.value
                ? flowSelect.options[flowSelect.selectedIndex].text
                : "") ||
              `Flow ${timeString}`;
          }
          renderSteps(testCase.steps || []);
          logLine(
            `Stopped recording. Captured ${testCase.steps?.length || 0} steps.`,
            "success",
          );
          await sendToBackend(testCase);
        }
      });
    }
  });
}

function onNewFlow() {
  testNameInput.value = "";
  if (flowSelect) {
    flowSelect.value = "";
  }
  renderSteps([]);
  logLine("New flow started.", "info");
}

function onSaveFlow() {
  const name = testNameInput.value.trim();
  if (!name) {
    alert("Please enter a flow name");
    return;
  }

  chrome.runtime.sendMessage({ type: "GET_STATE" }, async (state) => {
    if ((!state || !state.currentTestCase) && currentSteps.length === 0) {
      logLine("No steps to save", "error");
      return;
    }

    const testCase = {
      ...(state?.currentTestCase || {}),
      name: name,
      steps: currentSteps, // Ensure we use what's on screen
    };

    await sendToBackend(testCase);
  });
}

async function onDeleteFlow() {
  const selectedId = flowSelect?.value;
  if (!selectedId || selectedId === "") {
    logLine("Please select a flow to delete", "error");
    return;
  }

  // Get flow name for confirmation
  const flowName =
    flowSelect.options[flowSelect.selectedIndex]?.textContent || "this flow";

  // Confirm deletion
  if (
    !confirm(
      `Are you sure you want to delete "${flowName}"?\n\nThis action cannot be undone.`,
    )
  ) {
    return;
  }

  try {
    logLine(`Deleting flow ID ${selectedId}...`, "info");
    const res = await fetch(`${API_BASE_URL}/api/test-cases/${selectedId}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(
        errorData.error || `Backend responded with status ${res.status}`,
      );
    }

    const data = await res.json();
    logLine(
      data.message || `Flow '${flowName}' deleted successfully`,
      "success",
    );

    // Clear current selection
    testNameInput.value = "";
    renderSteps([]);
    flowSelect.value = "";

    // Remove from Chrome storage
    await chrome.storage.local.remove([`flow_${selectedId}`]);

    // Reload flows from backend
    await loadFlowsFromBackend();

    logLine("Flow list refreshed");
  } catch (err) {
    console.error("Error deleting flow", err);
    logLine("Error deleting flow: " + err.message, "error");
    statusText.textContent = "Error: " + err.message;
  }
}

async function onFlowSelect() {
  const selectedId = flowSelect?.value;
  if (!selectedId || selectedId === "") {
    renderSteps([]);
    testNameInput.value = "";
    return;
  }

  try {
    logLine(`Loading flow ID ${selectedId} from database...`, "info");
    const res = await fetch(`${API_BASE_URL}/api/test-cases/${selectedId}`);
    if (!res.ok) {
      throw new Error(
        `Backend responded with status ${res.status}. Make sure backend is running on ${API_BASE_URL}`,
      );
    }

    const testCase = await res.json();

    if (!testCase || !testCase.steps) {
      throw new Error(
        "Flow loaded but has no steps. Data may not be saved in database.",
      );
    }

    testNameInput.value = testCase.name;
    renderSteps(testCase.steps || []);
    logLine(
      `Loaded flow '${testCase.name}' with ${testCase.steps?.length || 0} steps from database`,
      "success",
    );

    // Store full test case in Chrome storage for offline access
    await chrome.storage.local.set({ [`flow_${selectedId}`]: testCase });

    // Don't auto-run - user must click "Run Flow" button
  } catch (err) {
    console.error("Error loading flow", err);
    logLine("Error loading flow: " + err.message, "error");
    statusText.textContent = "Error: " + err.message;

    // Try to load from Chrome storage as fallback
    try {
      const result = await chrome.storage.local.get([`flow_${selectedId}`]);
      if (result[`flow_${selectedId}`]) {
        const cachedFlow = result[`flow_${selectedId}`];
        testNameInput.value = cachedFlow.name;
        renderSteps(cachedFlow.steps || []);
        logLine(
          `Loaded flow '${cachedFlow.name}' from local cache (${cachedFlow.steps?.length || 0} steps)`,
          "info",
        );
        // Don't auto-run - user must click "Run Flow" button
      } else {
        logLine(
          "Flow not found in local cache. Please ensure backend is running and try again.",
        );
      }
    } catch (cacheErr) {
      logLine("Failed to load from cache: " + cacheErr.message);
    }
  }
}

async function runFlow(testCase) {
  if (!testCase.steps || testCase.steps.length === 0) {
    logLine("No steps to execute", "error");
    return;
  }

  currentRunningFlowName = testCase.id
    ? `${testCase.id} - ${testCase.name || "Current Flow"}`
    : testCase.name || "Current Flow";
  setRunningFlow(currentRunningFlowName);
  resetFailureStatus();

  logLine(
    `Starting execution of flow '${currentRunningFlowName}' (${testCase.steps.length} steps)...`,
    "info",
  );
  currentSteps = testCase.steps; // SYNC STEPS
  agentStatus.textContent = "Running";
  agentStatus.style.color = "#fbbf24";
  setExecutionUI(true);

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) {
      throw new Error("No active tab found");
    }

    // Check if tab URL is injectable
    if (
      tab.url &&
      (tab.url.startsWith("chrome://") ||
        tab.url.startsWith("chrome-extension://") ||
        tab.url.startsWith("edge://"))
    ) {
      throw new Error(
        "Cannot execute on this page. Please navigate to a regular webpage (http:// or https://).",
      );
    }

    // Send START_EXECUTION to background
    const response = await chrome.runtime.sendMessage({
      type: "START_EXECUTION",
      testCase: testCase,
      tabId: tab.id,
    });

    if (response && response.success) {
      logLine("Flow execution started in background...", "info");
    } else {
      throw new Error(response?.error || "Failed to start execution");
    }

    // Reset index on start
    executionActiveIndex = 0;
    renderSteps(currentSteps);
  } catch (err) {
    console.error("Error starting flow", err);
    logLine("Error starting flow: " + err.message, "error");
    agentStatus.textContent = "Error";
    agentStatus.style.color = "#ef4444";
    setExecutionUI(false);
  }
}

function onStopExecution() {
  chrome.runtime.sendMessage({ type: "STOP_EXECUTION" });
  logLine("Sending stop command...");
}

// Listen for steps recorded or execution status updates in real-time
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STEP_RECORDED") {
    currentSteps.push(message.step);
    renderSteps(currentSteps);
  } else if (message.type === "EXECUTION_STATUS_UPDATE") {
    if (message.success) {
      logLine(
        `Flow execution completed successfully (${message.stepCount} steps)`,
        "success",
      );

      if (message.bugs && message.bugs.length > 0) {
        renderBugReport(message.bugs);
        const nuances = message.bugs.filter((b) => b.type === "nuance");
        if (nuances.length > 0) {
          logLine(
            `Found ${nuances.length} nuances. Check "Bugs" tab for details.`,
            "warning",
          );
        }
      } else {
        renderBugReport([]);
      }

      agentStatus.textContent = "Ready";
      agentStatus.style.color = "#4ade80";
      setRunningFlow(
        currentRunningFlowName
          ? `${currentRunningFlowName} (success)`
          : "Success",
      );
      resetFailureStatus();
      executionActiveIndex = -1;
      renderSteps(currentSteps);
      setExecutionUI(false);
    } else if (message.error) {
      logLine(`Flow execution failed: ${message.error}`, "error");

      if (message.bugs && message.bugs.length > 0) {
        renderBugReport(message.bugs);
        const errors = message.bugs.filter((b) => b.type === "error");
        if (errors.length > 0) {
          logLine(
            `Detected ${errors.length} errors during execution. Check "Bugs" tab.`,
            "error",
          );
        }
      }

      agentStatus.textContent = "Error";
      agentStatus.style.color = "#ef4444";
      setRunningFlow(
        currentRunningFlowName
          ? `${currentRunningFlowName} (failed)`
          : "Failed",
      );
      if (!firstFailureMessage) {
        const stepIndex = extractStepIndexFromMessage(message.error);
        firstFailureMessage =
          stepIndex !== null
            ? `Step ${stepIndex}: ${message.error}`
            : message.error;
        setFirstFailure(firstFailureMessage);
      }
      executionActiveIndex = -1;
      renderSteps(currentSteps);
      setExecutionUI(false);
    }
  } else if (message.type === "STEP_COMPLETE") {
    executionActiveIndex = message.stepIndex + 1;
    renderSteps(currentSteps);
  } else if (message.type === "LOG_MESSAGE") {
    logLine(message.text, message.level || "info");
    if (
      (message.level === "error" || message.level === "warning") &&
      !firstFailureMessage
    ) {
      const stepIndex = extractStepIndexFromMessage(message.text || "");
      if (stepIndex !== null) {
        firstFailureMessage = `Step ${stepIndex}: ${message.text}`;
        setFirstFailure(firstFailureMessage);
      }
    }
  }
});

async function onRunFlow() {
  const selectedId = flowSelect?.value;
  let testCase = null;

  if (!selectedId || selectedId === "") {
    // Check if we have current steps (e.g. from upload or recording)
    if (currentSteps.length > 0) {
      testCase = {
        name: testNameInput.value.trim() || "Current Flow",
        steps: currentSteps,
      };
      logLine(`Running current flow...`, "info");
    } else {
      logLine("Please select a flow or record some steps first", "error");
      return;
    }
  } else {
    // Check if we have it in Chrome storage first
    const result = await chrome.storage.local.get([`flow_${selectedId}`]);
    if (result[`flow_${selectedId}`]) {
      testCase = result[`flow_${selectedId}`];
      logLine(`Using cached flow '${testCase.name}'`, "info");
    } else {
      // Load from backend
      try {
        logLine(`Loading flow ID ${selectedId} from database...`, "info");
        const res = await fetch(`${API_BASE_URL}/api/test-cases/${selectedId}`);
        if (!res.ok)
          throw new Error(`Backend responded with status ${res.status}`);
        testCase = await res.json();
      } catch (err) {
        logLine("Error loading flow: " + err.message, "error");
        return;
      }
    }
  }

  if (!testCase || !testCase.steps || testCase.steps.length === 0) {
    logLine("Flow has no steps to execute", "error");
    return;
  }

  // Run the flow
  await runFlow(testCase);
}

if (recordBtn) {
  recordBtn.addEventListener("click", onRecordClick);
}
if (newFlowBtn) {
  newFlowBtn.addEventListener("click", onNewFlow);
}
if (saveFlowBtn) {
  saveFlowBtn.addEventListener("click", onSaveFlow);
}
if (deleteFlowBtn) {
  deleteFlowBtn.addEventListener("click", onDeleteFlow);
}
if (runFlowBtn) {
  runFlowBtn.addEventListener("click", onRunFlow);
}
if (stopExecutionBtn) {
  stopExecutionBtn.addEventListener("click", onStopExecution);
}
if (exportCodeBtn) {
  exportCodeBtn.addEventListener("click", onExportCode);
}
if (exportJsonBtn) {
  exportJsonBtn.addEventListener("click", onExportJson);
}
if (uploadJsonBtn) {
  uploadJsonBtn.addEventListener("click", onUploadJson);
}

const clearHistoryBtn = document.getElementById("clearHistoryBtn");
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener("click", async () => {
    if (
      !confirm(
        "Are you sure you want to clear all execution history?\n\nThis will permanently delete all execution records from the database.",
      )
    ) {
      return;
    }

    try {
      const tbody = document.getElementById("historyTableBody");
      tbody.innerHTML =
        '<tr><td colspan="3" style="padding: 20px; text-align: center; color: #64748b;">Clearing...</td></tr>';

      // Delete all executions via API
      const res = await fetch(`${API_BASE_URL}/api/executions/clear`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error(`Failed to clear history: ${res.status}`);
      }

      tbody.innerHTML =
        '<tr><td colspan="3" style="padding: 20px; text-align: center; color: #64748b;">No runs yet</td></tr>';
      logLine("Execution history cleared", "success");
    } catch (err) {
      logLine("Error clearing history: " + err.message, "error");
      loadExecutionHistory(); // Reload to show current state
    }
  });
}

if (popoutBtn) {
  popoutBtn.addEventListener("click", () => {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 460,
      height: 700,
    });
    window.close(); // Close the actual popup
  });
}

if (flowSelect) {
  flowSelect.addEventListener("change", onFlowSelect);
}

function renderBugReport(bugs = []) {
  const bugList = document.getElementById("bugList");
  const bugCount = document.getElementById("bugCount");

  if (!bugs.length) {
    bugList.innerHTML =
      '<div style="color: #64748b; font-style: italic">No bugs detected in recent run.</div>';
    bugCount.style.display = "none";
    return;
  }

  bugCount.textContent = bugs.length;
  bugCount.style.display = "inline";

  bugList.innerHTML = "";
  bugs.forEach((bug) => {
    const entry = document.createElement("div");
    entry.style.padding = "6px";
    entry.style.marginBottom = "6px";
    entry.style.borderLeft = `3px solid ${bug.type === "error" ? "#ef4444" : "#fbbf24"}`;
    entry.style.background = "rgba(255,255,255,0.03)";
    entry.style.borderRadius = "2px";

    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.style.fontSize = "12px";
    title.style.color = bug.type === "error" ? "#f87171" : "#fbbf24";
    title.textContent = `${bug.type.toUpperCase()} at Step ${bug.stepIndex + 1}`;

    const msg = document.createElement("div");
    msg.style.marginTop = "2px";
    msg.textContent = bug.message;

    entry.appendChild(title);
    entry.appendChild(msg);
    bugList.appendChild(entry);
  });

  // Automatically switch to bugs tab if it's the first time seeing them
  const bugsTab = document.querySelector('.tab[data-tab="bugs"]');
  if (bugsTab) bugsTab.click();
}

init();

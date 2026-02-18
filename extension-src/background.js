// Background/service worker for coordinating recording state and communication

let isRecording = false;
let currentTestCase = { name: "Untitled Test", steps: [] };
let lastExecutionStatus = null;
const API_BASE_URL = "http://localhost:4000";

// Execution state
let executionState = {
  isRunning: false,
  tabId: null,
  steps: [],
  currentIndex: 0,
  waitingForNavigation: false,
  stepResults: [],
  testId: null,
  startTime: null,
};

async function saveExecutionState() {
  backgroundLog(
    `Saving execution state: Index=${executionState.currentIndex}, Running=${executionState.isRunning}, Steps=${executionState.steps.length}`,
    "debug",
  );
  await chrome.storage.local.set({ execution_state_v2: executionState });
}

let isStateLoaded = false;

async function loadExecutionState() {
  try {
    const data = await chrome.storage.local.get("execution_state_v2");
    if (data.execution_state_v2) {
      executionState = data.execution_state_v2;
      console.log(
        `[Background] Restored Index=${executionState.currentIndex}, Running=${executionState.isRunning}`,
      );

      if (executionState.isRunning && !executionState.waitingForNavigation) {
        console.log("[Background] Resuming execution...");
        setTimeout(() => executeCurrentStep(), 2000);
      }
    }
  } catch (e) {
    console.error("[Background] Load state error:", e);
  } finally {
    isStateLoaded = true;
  }
}

// Initialize state
loadExecutionState();

function backgroundLog(text, level = "info") {
  console.log(`[${level}] ${text}`);
  chrome.runtime
    .sendMessage({ type: "LOG_MESSAGE", text, level })
    .catch(() => {});
  // Removed persistent storage logging to prevent IO-related stalls during busy E2E runs
}

async function recordStepResult(stepIndex, status, message = null) {
  if (typeof stepIndex !== "number") return;
  if (!executionState.stepResults) executionState.stepResults = [];
  const exists = executionState.stepResults.some(
    (r) => r.stepIndex === stepIndex,
  );
  if (exists) return;
  executionState.stepResults.push({
    stepIndex,
    status,
    message,
    timestamp: Date.now(),
  });
  await saveExecutionState();
}

async function postExecutionReport(
  status,
  error = null,
  ariaSnapshotUrl = null,
) {
  if (!executionState.testId) {
    backgroundLog(
      "postExecutionReport: Missing testId, report skipped",
      "warning",
    );
    return;
  }

  try {
    const duration = executionState.startTime
      ? Date.now() - executionState.startTime
      : 0;

    backgroundLog(
      `Posting execution report: Status=${status}, TestID=${executionState.testId}, Duration=${duration}ms`,
      "info",
    );

    const res = await fetch(
      `${API_BASE_URL}/api/tests/${executionState.testId}/executions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          duration,
          errorMessage: error,
          ariaSnapshotUrl: ariaSnapshotUrl || null,
          stepResults: executionState.stepResults || [],
        }),
      },
    );

    if (!res.ok) {
      const errorText = await res.text();
      backgroundLog(
        `Backend error posting report: ${res.status} ${errorText}`,
        "error",
      );
    } else {
      backgroundLog("Execution report saved to database", "success");
    }
  } catch (err) {
    backgroundLog(`Fetch error posting report: ${err.message}`, "error");
  }
}

async function executeCurrentStep() {
  if (!executionState.isRunning) return;

  if (executionState.currentIndex >= executionState.steps.length) {
    // Check if any steps had failures before declaring success
    const failedSteps = (executionState.stepResults || []).filter(
      (r) => r.status === "failed",
    );
    if (failedSteps.length > 0) {
      const failedMsg = failedSteps
        .map((s) => `Step ${s.stepIndex + 1}: ${s.message || "failed"}`)
        .join("; ");
      await finishExecution(false, `Completed with errors: ${failedMsg}`);
    } else {
      await finishExecution(true);
    }
    return;
  }

  const step = executionState.steps[executionState.currentIndex];

  console.log(
    `Executing step ${executionState.currentIndex + 1}/${executionState.steps.length}: ${step.action} on ${step.description || step.selector}`,
  );

  try {
    // Clear any previous timeout
    if (executionState.stepTimeout) {
      clearTimeout(executionState.stepTimeout);
    }

    const isScrollStep = step.action === "scroll";
    const isInputStep = step.action === "input";
    const stepTimeoutMs = isScrollStep ? 4000 : 30000;

    // Set a timeout for this step.
    // If no frame responds with STEP_COMPLETE, we fail (or auto-advance for scroll).
    executionState.stepTimeout = setTimeout(async () => {
      console.error(
        `Timeout waiting for step ${executionState.currentIndex + 1}/${executionState.steps.length}`,
      );

      if (isScrollStep) {
        // Scroll steps are best-effort; auto-advance to avoid stalls.
        if (executionState.stepTimeout) {
          clearTimeout(executionState.stepTimeout);
          executionState.stepTimeout = null;
        }
        await recordStepResult(executionState.currentIndex, "success");
        executionState.currentIndex++;
        await saveExecutionState();
        setTimeout(() => executeCurrentStep(), 500);
        return;
      }

      await recordStepResult(
        executionState.currentIndex,
        "failed",
        `Timeout waiting for step ${executionState.currentIndex + 1}`,
      );
      await finishExecution(
        false,
        `Timeout waiting for step ${executionState.currentIndex + 1}`,
      );
    }, stepTimeoutMs);

    const tab = await chrome.tabs.get(executionState.tabId);

    // Check if we need to navigate
    const currentUrl = normalizeUrl(tab.url);
    const stepUrl = normalizeUrl(step.url);
    const isArchiveOrg = currentUrl.includes("web.archive.org");

    // For interaction steps (click, input, scroll), we use path-only matching
    // to avoid unwanted reloads when query parameters change in an SPA.
    const isInteractionStep = ["click", "input", "scroll"].includes(
      step.action,
    );
    const urlsMatch = isInteractionStep
      ? urlsHaveSamePath(currentUrl, stepUrl)
      : currentUrl === stepUrl;

    if (step.url && !urlsMatch && !isArchiveOrg) {
      console.log(
        `Step requires navigation: Current: ${currentUrl}, Target: ${stepUrl}`,
      );
      chrome.runtime
        .sendMessage({
          type: "LOG_MESSAGE",
          text: `Navigating to match step URL: ${step.url}`,
          level: "info",
        })
        .catch(() => {});

      executionState.waitingForNavigation = true;
      await chrome.tabs.update(executionState.tabId, { url: step.url });
      return;
    }

    // Attempt to inject content script to ensure it's there
    try {
      await chrome.scripting.executeScript({
        target: { tabId: executionState.tabId, allFrames: true },
        files: [
          "utils.js",
          "locator-builders.js",
          "recorder.js",
          "playback.js",
          "content.js",
        ],
      });
    } catch (e) {
      console.log("Injection check:", e.message);
    }

    // Send command to content script
    chrome.tabs.sendMessage(
      executionState.tabId,
      {
        type: "EXECUTE_SINGLE_STEP",
        step: step,
        stepIndex: executionState.currentIndex,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("Msg Error:", chrome.runtime.lastError.message);
        }
      },
    );
  } catch (err) {
    if (executionState.stepTimeout) clearTimeout(executionState.stepTimeout);
    finishExecution(false, err.message);
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove trailing slash and fragment for comparison
    return u.origin + u.pathname.replace(/\/$/, "") + u.search;
  } catch (e) {
    return url;
  }
}

function urlsHaveSamePath(url1, url2) {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    if (u1.origin !== u2.origin) return false;

    // Normalize paths by removing trailing slash and common organization prefixes
    const normalizePath = (p) =>
      p.replace(/\/$/, "").replace(/^\/(ovs|accordd|billing|inventory)\//, "/");

    return normalizePath(u1.pathname) === normalizePath(u2.pathname);
  } catch (e) {
    return url1 === url2;
  }
}

async function finishExecution(success, error = null) {
  const finalIndex = executionState.currentIndex;
  const totalSteps = executionState.steps.length;
  backgroundLog(
    `Flow execution finished: Success=${success} (${finalIndex}/${totalSteps} steps)`,
    success ? "success" : "error",
  );

  // Keep isRunning: true until we actually finish the report to avoid losing state during suspension
  executionState.waitingForNavigation = false;

  let ariaSnapshotUrl = null;
  if (executionState.tabId) {
    try {
      const logMsg = success
        ? "Capturing ARIA snapshot for successful run..."
        : "Capturing ARIA snapshot for manual failure...";
      backgroundLog(logMsg, "info");
      const resp = await chrome.tabs
        .sendMessage(executionState.tabId, { type: "GET_ARIA_SNAPSHOT" })
        .catch(() => null);

      if (resp && resp.success && resp.snapshot) {
        const uploadRes = await fetch(`${API_BASE_URL}/api/snapshots/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            testId: executionState.testId,
            snapshot: resp.snapshot,
            type: success ? "success" : "manual_failure",
          }),
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          ariaSnapshotUrl = uploadData.url;
          backgroundLog(
            `ARIA snapshot uploaded: ${ariaSnapshotUrl}`,
            "success",
          );
        }
      }
    } catch (e) {
      backgroundLog(
        `Failed to capture/upload ARIA snapshot: ${e.message}`,
        "warning",
      );
    }
  }

  const status = {
    success,
    error,
    stepCount: finalIndex,
    ariaSnapshotUrl,
  };

  // Ensure report is posted before worker might terminate
  try {
    await postExecutionReport(
      success ? "success" : "failed",
      error,
      ariaSnapshotUrl,
    );
    backgroundLog("Final report confirmed saved.", "debug");
  } catch (e) {
    backgroundLog(`Final report failed: ${e.message}`, "error");
  }

  // Now we can safely stop
  executionState.isRunning = false;
  lastExecutionStatus = status;
  await saveExecutionState();

  chrome.runtime
    .sendMessage({
      type: "EXECUTION_STATUS_UPDATE",
      ...status,
    })
    .catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 1. Maintain recording state across reloads/navigation
  if (isRecording && changeInfo.status === "complete" && tab.active) {
    chrome.tabs
      .sendMessage(tabId, {
        type: "SET_RECORDING",
        isRecording: true,
      })
      .catch(() => {
        // Ignore errors if content script isn't ready yet or strictly not injectable
      });
  }

  if (
    executionState.isRunning &&
    tabId === executionState.tabId &&
    changeInfo.status === "complete"
  ) {
    // If we were explicitly waiting for navigation, OR if a navigation happened naturally
    // (like a click causing page load), we should check if we can proceed.

    // If we were waiting for navigation, resume now.
    if (executionState.waitingForNavigation) {
      executionState.waitingForNavigation = false;
      // Give page a moment to settle?
      setTimeout(() => executeCurrentStep(), 500);
    } else {
      // If we weren't explicitly waiting, but a load happened,
      // it might be due to the previous step (Click).
      // So we should re-inject logic if needed or just let the step completion handler fire?

      // PROBLEM: If the page reloads, the content script that was processing the click is dead.
      // It never sent "STEP_COMPLETE".
      // So if we see a load complete, and we are stuck on a step that was a 'click',
      // we should assume it succeeded and move to next?

      // Let's implement that heuristic.
      const currentStep = executionState.steps[executionState.currentIndex];
      if (currentStep && currentStep.action === "click") {
        console.log(
          "Detected page load during click step. Assuming success and moving next.",
        );
        // CRITICAL: Clear the timeout before advancing to prevent race condition
        if (executionState.stepTimeout) {
          clearTimeout(executionState.stepTimeout);
          executionState.stepTimeout = null;
        }
        recordStepResult(executionState.currentIndex, "success");
        executionState.currentIndex++;
        setTimeout(() => executeCurrentStep(), 2500); // Increased from 2000ms to allow Salesforce/complex pages to fully settle
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Use a naked storage set for immediate diagnostic visibility that survives worker restarts
  const logKey = `msg_log_${Date.now()}`;
  chrome.storage.local.set({
    [logKey]: {
      type: message.type,
      from: sender.tab ? sender.tab.id : "ext",
      at: new Date().toISOString(),
    },
  });

  handleMessageAsync(message, sender, sendResponse);
  return true; // Keep channel open
});

async function handleMessageAsync(message, sender, sendResponse) {
  // Use a longer poll if state not loaded yet - busy E2E profiles can be slow
  if (!isStateLoaded) {
    console.log(
      `[Background] Waiting for state load (msg: ${message.type})...`,
    );
    for (let i = 0; i < 50 && !isStateLoaded; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!isStateLoaded) {
      console.error(
        `[Background] WARNING: State load timeout for message ${message.type}`,
      );
    }
  }

  if (message.type === "START_RECORDING") {
    isRecording = true;
    currentTestCase = { name: message.name || "Untitled Test", steps: [] };
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs[0];
      if (activeTab) {
        try {
          // 1. Ensure scripts are injected in all frames
          await chrome.scripting
            .executeScript({
              target: { tabId: activeTab.id, allFrames: true },
              files: [
                "utils.js",
                "locator-builders.js",
                "recorder.js",
                "playback.js",
                "content.js",
              ],
            })
            .catch((e) => console.log("Injection skipped/failed:", e.message));

          // 2. toggle state in ALL frames directly
          await chrome.scripting.executeScript({
            target: { tabId: activeTab.id, allFrames: true },
            func: (state) => {
              if (window.__recorder_toggle) {
                window.__recorder_toggle(state);
              }
            },
            args: [true], // isRecording = true
          });

          // Legacy/Backup: Send message to top frame (popup might rely on this return?)
          // Actually, we just need to send response to the popup
        } catch (err) {
          console.error("Failed to start recording:", err);
        }
      }
    });
    sendResponse({ success: true });
  } else if (message.type === "STOP_RECORDING") {
    isRecording = false;
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        // Toggle state in ALL frames
        await chrome.scripting
          .executeScript({
            target: { tabId: tabs[0].id, allFrames: true },
            func: (state) => {
              if (window.__recorder_toggle) {
                window.__recorder_toggle(state);
              }
            },
            args: [false],
          })
          .catch(() => {});
      }
    });
    sendResponse({ success: true, testCase: currentTestCase });
  } else if (message.type === "RECORD_STEP") {
    if (isRecording && message.step) {
      currentTestCase.steps.push({
        ...message.step,
        timestamp: Date.now(),
      });
    }
    sendResponse({ success: true });
  } else if (message.type === "GET_STATE") {
    sendResponse({ isRecording, currentTestCase, lastExecutionStatus });
  }

  // EXECUTION HANDLING
  else if (message.type === "START_EXECUTION") {
    executionState = {
      isRunning: true,
      tabId: message.tabId,
      steps: message.testCase.steps || [],
      currentIndex: 0,
      waitingForNavigation: false,
      stepResults: [],
      testId: message.testCase.id || null,
      startTime: Date.now(),
    };

    await saveExecutionState();
    executeCurrentStep();
    sendResponse({ success: true });
  } else if (message.type === "STEP_COMPLETE") {
    if (executionState.isRunning) {
      const currentStep = executionState.steps[executionState.currentIndex];
      console.log(
        `STEP_COMPLETE received for step ${executionState.currentIndex + 1} (${currentStep ? currentStep.action : "unknown"}). timeout=${!!executionState.stepTimeout}`,
      );

      chrome.runtime
        .sendMessage({
          type: "LOG_MESSAGE",
          text: `Background: Received completion for Step ${executionState.currentIndex + 1}.`,
          level: "debug",
        })
        .catch(() => {});

      if (executionState.stepTimeout) {
        clearTimeout(executionState.stepTimeout);
        executionState.stepTimeout = null;
      }

      await recordStepResult(executionState.currentIndex, "success");
      executionState.currentIndex++;
      await saveExecutionState();

      console.log(
        `Advancing to next step. New index: ${executionState.currentIndex}, Total: ${executionState.steps.length}`,
      );
      try {
        await executeCurrentStep();
      } catch (err) {
        console.error(`[Background] Error advancing step: ${err.message}`);
        await postExecutionReport(
          "failed",
          `Internal error advancing: ${err.message}`,
        );
      }
    } else {
      console.warn(
        "STEP_COMPLETE received but executionState.isRunning is false",
      );
    }
    sendResponse({ success: true });
  } else if (message.type === "STEP_ERROR") {
    if (executionState.isRunning) {
      // Clear the timeout before finishing execution
      if (executionState.stepTimeout) {
        clearTimeout(executionState.stepTimeout);
        executionState.stepTimeout = null;
      }
      recordStepResult(
        typeof message.stepIndex === "number"
          ? message.stepIndex
          : executionState.currentIndex,
        "failed",
        message.error,
      );
      await finishExecution(false, message.error);
    }
    sendResponse({ success: true });
  }
}

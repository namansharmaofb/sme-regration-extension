// High-level controller for playing back flows in the background

/**
 * Normalizes a URL for stable comparison.
 * @param {string} url
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch (e) {
    return url;
  }
}

/**
 * Sends a log message to the popup if it's open.
 * @param {string} text
 * @param {string} level
 */
function sendPopupLog(text, level = "info") {
  chrome.runtime
    .sendMessage({
      type: "LOG_MESSAGE",
      text,
      level,
    })
    .catch(() => {});
}

const API_BASE_URL = "http://localhost:4000";

/**
 * Finishes the current execution and notifies the user/popup.
 * @param {boolean} success
 * @param {string} error
 */
async function finishExecution(success, error = null) {
  if (executionState.stepTimeout) {
    clearTimeout(executionState.stepTimeout);
    executionState.stepTimeout = null;
  }

  const duration = executionState.startTime
    ? Date.now() - executionState.startTime
    : 0;
  const status = success
    ? "success"
    : error === "User stopped execution"
      ? "stopped"
      : "failed";

  executionState.isRunning = false;
  executionState.waitingForNavigation = false;

  const statusObj = {
    success,
    error,
    stepCount: executionState.currentIndex + (success ? 0 : error ? 0 : 1),
    bugs: executionState.detectedBugs || [],
  };

  chrome.runtime
    .sendMessage({
      type: "EXECUTION_STATUS_UPDATE",
      ...statusObj,
    })
    .catch(() => {});

  if (error) {
    sendPopupLog(`Flow execution failed: ${error}`, "error");
  } else if (success) {
    sendPopupLog(`Flow execution completed successfully!`, "success");
  }

  // Send report to backend
  if (executionState.testId) {
    try {
      await fetch(
        `${API_BASE_URL}/api/tests/${executionState.testId}/executions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: status,
            duration: duration,
            bugs: executionState.detectedBugs,
            errorMessage: error,
          }),
        },
      );
      console.log("Execution report saved to backend.");
    } catch (err) {
      console.error("Failed to save execution report:", err);
    }
  }

  lastExecutionStatus = statusObj;
  saveState();
}

/**
 * Executes the current step in the execution queue.
 */
const STEP_TIMEOUT_MS = 20000;
const BROADCAST_MAX_ATTEMPTS = 20;
const BROADCAST_INTERVAL_MS = 1000;

async function executeCurrentStep() {
  if (!executionState.isRunning) return;

  if (executionState.currentIndex >= executionState.steps.length) {
    // Check if any bugs were detected before declaring success
    const hasBugs = (executionState.detectedBugs || []).length > 0;
    if (hasBugs) {
      const bugMsg = executionState.detectedBugs
        .map((b) => `Step ${b.stepIndex + 1}: ${b.message}`)
        .join("; ");
      finishExecution(false, `Completed with bugs: ${bugMsg}`);
    } else {
      finishExecution(true);
    }
    return;
  }

  // Prevent double-execution of the same index
  if (executionState.executingIndex === executionState.currentIndex) {
    return;
  }
  executionState.executingIndex = executionState.currentIndex;

  const index = executionState.currentIndex;
  const step = executionState.steps[index];
  executionState.activeStepAction = step.action;
  saveState();

  const stepInfo = `Step ${index + 1}/${executionState.steps.length}: ${step.action}`;
  console.log(stepInfo);
  sendPopupLog(`Executing ${stepInfo}...`, "info");

  try {
    if (executionState.stepTimeout) {
      clearTimeout(executionState.stepTimeout);
    }

    // Set a global timeout for this step
    executionState.stepTimeout = setTimeout(() => {
      console.error(`Timeout waiting for step ${index + 1}`);
      finishExecution(
        false,
        `Timeout waiting for step ${index + 1} (${Math.round(STEP_TIMEOUT_MS / 1000)}s limit)`,
      );
    }, STEP_TIMEOUT_MS);

    const tab = await chrome.tabs.get(executionState.tabId);
    if (!tab) {
      console.error(`Target tab ${executionState.tabId} not found`);
      throw new Error(`Target tab ${executionState.tabId} not found`);
    }

    const currentUrl = normalizeUrl(tab.url);
    const stepUrl = normalizeUrl(step.url);
    console.log(`Current URL: ${currentUrl}, Step URL: ${stepUrl}`);

    // Add persistent logs for E2E debugging
    const { e2e_debug_logs = [] } =
      await chrome.storage.local.get("e2e_debug_logs");
    e2e_debug_logs.push(
      `[${new Date().toISOString()}] Step ${index + 1}: ${step.action} on ${stepUrl}`,
    );
    await chrome.storage.local.set({ e2e_debug_logs });

    if (step.action === "navigate") {
      // If already on the page, just advance
      if (currentUrl === stepUrl) {
        console.log("Already on target URL, skipping navigation.");
        await log(`Engine: Already on ${stepUrl}, skipping navigation.`);
        executionState.currentIndex++;
        chrome.runtime
          .sendMessage({ type: "STEP_COMPLETE", stepIndex: index })
          .catch(() => {});
        setTimeout(() => executeCurrentStep(), 1500);
        return;
      }
      executionState.waitingForNavigation = true;
      executionState.activeStepAction = "navigate";
      await log(`Engine: Triggering navigation to ${step.url}`);
      await chrome.tabs.update(executionState.tabId, { url: step.url });
      return;
    }

    // BROADCAST to all frames
    let sendAttempts = 0;
    const maxSendAttempts = BROADCAST_MAX_ATTEMPTS; // Reduced for faster failure feedback

    const sendMessageToAllFrames = async () => {
      if (!executionState.isRunning || executionState.currentIndex !== index)
        return;

      try {
        const frames = await chrome.webNavigation.getAllFrames({
          tabId: executionState.tabId,
        });

        // Ensure scripts are injected in all frames before sending
        await chrome.scripting
          .executeScript({
            target: { tabId: executionState.tabId, allFrames: true },
            files: [
              "utils.js",
              "locator-builders.js",
              "recorder.js",
              "playback.js",
              "content.js",
            ],
          })
          .catch(() => {});

        frames.forEach((frame) => {
          chrome.tabs
            .sendMessage(
              executionState.tabId,
              { type: "EXECUTE_SINGLE_STEP", step: step, stepIndex: index },
              { frameId: frame.frameId },
            )
            .catch(() => {}); // Expected if frame is cross-origin or gone
        });

        // Periodic update for long discovery
        sendAttempts++;
        if (sendAttempts % 3 === 0 && sendAttempts < maxSendAttempts) {
          sendPopupLog(
            `Step ${index + 1}: Still searching for element (Attempt ${sendAttempts}/${maxSendAttempts})...`,
            "info",
          );
        }

        // Check if we reached the max attempts for broadcast
        if (sendAttempts < maxSendAttempts) {
          setTimeout(sendMessageToAllFrames, BROADCAST_INTERVAL_MS);
        } else {
          const errorMsg = `Element not found after ${maxSendAttempts} search attempts.`;
          // Record as a bug on the specific step so the report isn't empty
          if (Array.isArray(executionState.detectedBugs)) {
            executionState.detectedBugs.push({
              stepIndex: index,
              type: "error",
              message: errorMsg,
            });
          }
          finishExecution(false, errorMsg);
        }
      } catch (err) {
        console.error("Frame broadcast error:", err);
        setTimeout(sendMessageToAllFrames, 1000);
      }
    };

    sendMessageToAllFrames();
  } catch (err) {
    finishExecution(false, err.message);
  }
}

// Global tab update listener for navigation handling
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Sync recording state
  if (isRecording && changeInfo.status === "complete" && tab.active) {
    chrome.tabs
      .sendMessage(tabId, { type: "SET_RECORDING", isRecording: true })
      .catch(() => {});
  }

  // Record auto-navigation
  if (
    isRecording &&
    changeInfo.url &&
    !changeInfo.url.startsWith("chrome://") &&
    tab.active
  ) {
    const lastStep = currentTestCase.steps[currentTestCase.steps.length - 1];
    const newUrl = normalizeUrl(changeInfo.url);
    const oldUrl = lastStep ? normalizeUrl(lastStep.url) : null;

    if (newUrl !== oldUrl) {
      currentTestCase.steps.push({
        action: "navigate",
        target: `url=${changeInfo.url}`,
        url: changeInfo.url,
        description: `Navigate to ${changeInfo.url}`,
        timestamp: Date.now(),
      });
      saveState();
      chrome.runtime
        .sendMessage({
          type: "STEP_RECORDED",
          step: currentTestCase.steps[currentTestCase.steps.length - 1],
        })
        .catch(() => {});
    }
  }

  // Handle execution navigation
  if (
    executionState.isRunning &&
    tabId === executionState.tabId &&
    changeInfo.status === "complete"
  ) {
    const hasActiveNavigationStep =
      executionState.activeStepAction === "navigate" ||
      executionState.activeStepAction === "click";

    if (
      (executionState.waitingForNavigation || hasActiveNavigationStep) &&
      executionState.isRunning
    ) {
      console.log(
        `Navigation complete detected for step ${executionState.currentIndex + 1}`,
      );
      chrome.storage.local
        .get("e2e_debug_logs")
        .then(async ({ e2e_debug_logs = [] }) => {
          e2e_debug_logs.push(
            `[${new Date().toISOString()}] Engine: Navigation COMPLETE for step ${executionState.currentIndex + 1}`,
          );
          await chrome.storage.local.set({ e2e_debug_logs });
        });

      executionState.waitingForNavigation = false;
      executionState.activeStepAction = null;
      executionState.currentIndex++;
      saveState();

      chrome.runtime
        .sendMessage({
          type: "STEP_COMPLETE",
          stepIndex: executionState.currentIndex - 1,
        })
        .catch(() => {});

      setTimeout(() => executeCurrentStep(), 3000); // 3.0s settle time
      return;
    }
  }
});

// Global state and persistence for the background service worker

let isRecording = false;
let currentTestCase = { name: "Untitled Test", steps: [] };
let lastExecutionStatus = null;

// Execution state
let executionState = {
  isRunning: false,
  tabId: null,
  testId: null,
  steps: [],
  currentIndex: 0,
  executingIndex: -1,
  waitingForNavigation: false,
  activeStepAction: null,
  stepTimeout: null,
  detectedBugs: [], // [{stepIndex, type, message}]
  startTime: null,
};

/**
 * Persistence: Save state to storage to handle service worker suspension.
 */
async function saveState() {
  try {
    // Do NOT persist the full steps array — it can be hundreds of KB for long flows.
    // Steps are already in the DB; only ephemeral state needs persistence.
    const { steps: _steps, ...lightExecutionState } = executionState;
    await chrome.storage.local.set({
      recorder_isRecording: isRecording,
      recorder_currentTestCase: currentTestCase,
      recorder_executionState: {
        ...lightExecutionState,
        stepTimeout: null,               // Don't persist timeout handles
        detectedBugs: (lightExecutionState.detectedBugs || []).slice(-20), // Cap at 20 entries
      },
      lastExecutionStatus: lastExecutionStatus,
    });
  } catch (e) {
    if (e && e.message && e.message.includes("quota")) {
      // Quota exceeded — purge cheap caches and retry once
      console.warn("Storage quota exceeded in saveState. Purging debug logs...");
      try {
        await chrome.storage.local.remove(["e2e_debug_logs", "recorder_currentTestCase"]);
        const { steps: _steps2, ...slim } = executionState;
        await chrome.storage.local.set({
          recorder_isRecording: isRecording,
          recorder_executionState: { ...slim, stepTimeout: null, detectedBugs: [] },
          lastExecutionStatus: lastExecutionStatus,
        });
      } catch (retryErr) {
        console.error("State save failed even after quota purge:", retryErr);
      }
    } else {
      console.warn("Failed to save state:", e);
    }
  }
}

/**
 * Persistence: Load state from storage on startup.
 */
async function loadState() {
  const data = await chrome.storage.local.get([
    "recorder_isRecording",
    "recorder_currentTestCase",
    "recorder_executionState",
    "lastExecutionStatus",
  ]);

  if (data.recorder_isRecording !== undefined)
    isRecording = data.recorder_isRecording;
  if (data.recorder_currentTestCase)
    currentTestCase = data.recorder_currentTestCase;
  if (data.lastExecutionStatus) lastExecutionStatus = data.lastExecutionStatus;

  if (data.recorder_executionState) {
    executionState = { ...executionState, ...data.recorder_executionState };

    // Auto-resume if we were running
    if (executionState.isRunning && typeof executeCurrentStep === "function") {
      console.log("Resuming execution after background restart...");
      // Wrap in a slight delay to ensure everything is initialized
      setTimeout(() => executeCurrentStep(), 1000);
    }
  }
}

// Initial load
loadState();

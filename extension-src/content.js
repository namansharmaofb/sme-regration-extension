/**
 * Entry point for the content script.
 * Synchronizes state with background and routes messages to recorder/playback modules.
 */

// Global state shared across modular scripts
if (typeof window.isRecording === "undefined") {
  window.isRecording = false;
}

// Prevent duplicate initialization
if (!window.__recorder_initialized) {
  window.__recorder_initialized = true;

  // Track the last right-clicked element for assertions
  window.lastRightClickedElement = null;
  window.addEventListener(
    "contextmenu",
    (event) => {
      const composedPath = event.composedPath();
      window.lastRightClickedElement =
        composedPath.length > 0 ? composedPath[0] : event.target;
    },
    true,
  );

  // Expose internal state changer for background script to call directly
  window.__recorder_toggle = function (state) {
    window.isRecording = state;
    if (typeof updateVisualIndicator === "function") {
      updateVisualIndicator(state);
    }
    console.log(
      "Recorder state updated to:",
      state,
      "in",
      window.location.href,
    );
  };

  // Initialize state from background
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (response) {
      window.__recorder_toggle(response.isRecording);
    }
  });

  // Message listener for external commands
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "SET_RECORDING") {
      window.__recorder_toggle(message.isRecording);
      sendResponse({ success: true, isRecording: window.isRecording });
    } else if (message.type === "EXECUTE_SINGLE_STEP") {
      if (typeof executeSingleStep === "function") {
        if (message.step.action.startsWith("assert")) {
          verifyAssertion(message.step, message.stepIndex)
            .then(() =>
              chrome.runtime.sendMessage({
                type: "STEP_COMPLETE",
                stepIndex: message.stepIndex,
              }),
            )
            .catch((err) =>
              chrome.runtime.sendMessage({
                type: "STEP_ERROR",
                error: err.message,
                stepIndex: message.stepIndex,
              }),
            );
        } else {
          executeSingleStep(message.step, message.stepIndex);
        }
      }
      sendResponse({ success: true, message: "Step execution started" });
    } else if (message.type === "GET_LAST_RIGHT_CLICKED") {
      if (
        typeof lastRightClickedElement !== "undefined" &&
        lastRightClickedElement
      ) {
        const selectors = generateSelectors(lastRightClickedElement);
        const descriptor = getElementDescriptor(lastRightClickedElement);
        const step = {
          selectors: selectors,
          selector: selectors.selector,
          selectorType: selectors.selectorType,
          tagName: lastRightClickedElement.tagName,
          description: descriptor,
          url: window.location.href,
        };
        sendResponse({ step });
      } else {
        sendResponse({ step: null });
      }
    } else if (message.type === "GET_ARIA_SNAPSHOT") {
      if (typeof captureAriaSnapshotContent === "function") {
        try {
          const snapshot = captureAriaSnapshotContent();
          sendResponse({ success: true, snapshot });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      } else {
        sendResponse({
          success: false,
          error: "ARIA snapshot utility not loaded",
        });
      }
    }
    return true;
  });

  // Verification log for injection debugging
  const frameType = window === window.top ? "TOP FRAME" : "SUBFRAME";
  console.log(
    `[${frameType}] Content script initialized at: ${window.location.href}`,
  );
  chrome.runtime
    .sendMessage({
      type: "LOG_MESSAGE",
      text: `[${frameType}] Script loaded: ${window.location.href}`,
      level: "debug",
    })
    .catch(() => {});

  console.log(
    "Web Test Recorder: Modular content script entry point initialized",
  );
}

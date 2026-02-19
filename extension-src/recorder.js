// Logic for capturing user interactions and reporting them to the background

/**
 * Finds the nearest interactive parent element.
 * @param {HTMLElement} element
 * @returns {HTMLElement}
 */
function getInteractiveParent(element) {
  if (!element || element === document.body) return element;

  let current = element;
  let depth = 0;
  const maxDepth = 10; // Slightly deeper for complex shadow DOM/MUI structures

  while (current && current !== document.body && depth < maxDepth) {
    const tagName = (current.tagName || "").toUpperCase();
    const role = (current.getAttribute("role") || "").toLowerCase();

    // Semantic interactive elements
    if (
      ["BUTTON", "A", "SELECT", "INPUT", "TEXTAREA"].includes(tagName) ||
      [
        "button",
        "link",
        "checkbox",
        "radio",
        "menuitem",
        "tab",
        "option",
      ].includes(role) ||
      current.hasAttribute("onclick") ||
      current.hasAttribute("tabindex")
    ) {
      return current;
    }

    // Common clickable patterns
    const style = window.getComputedStyle(current);
    if (
      current.classList.contains("btn") ||
      current.classList.contains("button") ||
      current.classList.contains("clickable") ||
      style.cursor === "pointer"
    ) {
      return current;
    }

    current = current.parentElement;
    depth++;
  }

  // Fallback: stay on original element but skip very small decoration elements if parent exists
  const targetTag = (element.tagName || "").toUpperCase();
  const decorationTags = [
    "SPAN",
    "I",
    "SMALL",
    "B",
    "STRONG",
    "SVG",
    "PATH",
    "USE",
    "CIRCLE",
    "RECT",
  ];

  if (decorationTags.includes(targetTag) && element.parentElement) {
    return element.parentElement;
  }

  return element;
}

/**
 * Handles clicks and records them as steps.
 * @param {MouseEvent} event
 */
function handleClick(event) {
  try {
    if (!window.isRecording) return;
    if (event.target.hasAttribute("data-recorder-ui")) return;

    // Use composedPath to get the actual target inside Shadow DOM
    const composedPath = event.composedPath();
    let target = composedPath.length > 0 ? composedPath[0] : event.target;

    // Promote to interactive parent if clicking on child element
    target = getInteractiveParent(target);

    const selectors = generateSelectors(target);
    const descriptor = getElementDescriptor(target);
    const nuanceMetadata = getElementState(target);

    // Calculate click offset relative to element
    const rect = target.getBoundingClientRect();
    const offsetX = Math.round(event.clientX - rect.left);
    const offsetY = Math.round(event.clientY - rect.top);

    const step = {
      action: "click",
      selectors: selectors.selectors, // NEW: Array of selector arrays
      selector: selectors.selector,
      selectorType: selectors.selectorType,
      tagName: target.tagName,
      description: descriptor,
      url: window.location.href,
      nuanceMetadata: nuanceMetadata,
      offsetX: offsetX,
      offsetY: offsetY,
    };

    chrome.runtime.sendMessage({ type: "RECORD_STEP", step });
  } catch (err) {
    console.error("Error recording click:", err);
  }
}

// Debounce timers for input recording
const inputTimers = new Map();

/**
 * Handles input change/input events and records them as steps (debounced).
 * @param {Event} event
 */
function handleInput(event) {
  try {
    if (!window.isRecording) return;

    // Use composedPath to get the actual target inside Shadow DOM
    const composedPath = event.composedPath();
    const target = composedPath.length > 0 ? composedPath[0] : event.target;
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
    )
      return;

    // Clear existing timer for this element
    if (inputTimers.has(target)) {
      clearTimeout(inputTimers.get(target));
    }

    // Set new timer to record after 300ms of no typing
    const timer = setTimeout(() => {
      recordInputStep(target);
      inputTimers.delete(target);
    }, 300);

    inputTimers.set(target, timer);
  } catch (err) {
    console.error("Error recording input:", err);
  }
}

/**
 * Records an input step (called after debounce).
 * @param {HTMLInputElement|HTMLTextAreaElement} target
 */
function recordInputStep(target) {
  try {
    const selectors = generateSelectors(target);
    const descriptor = getElementDescriptor(target);
    const nuanceMetadata = getElementState(target);

    const step = {
      action: "input",
      selectors: selectors.selectors, // NEW: Array of selector arrays
      selector: selectors.selector,
      selectorType: selectors.selectorType,
      tagName: target.tagName,
      value: target.value,
      description: descriptor,
      url: window.location.href,
      nuanceMetadata: nuanceMetadata,
    };

    chrome.runtime.sendMessage({ type: "RECORD_STEP", step });
  } catch (err) {
    console.error("Error recording input step:", err);
  }
}

/**
 * Handles change events to record final input value.
 * @param {Event} event
 */
function handleChange(event) {
  try {
    if (!window.isRecording) return;

    const target = event.target;
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
    )
      return;

    // Handle file upload inputs separately
    if (target instanceof HTMLInputElement && target.type === "file") {
      const fileNames = Array.from(target.files || []).map((f) => f.name);
      if (fileNames.length === 0) return;

      const selectors = generateSelectors(target);
      const descriptor = getElementDescriptor(target) || "File Upload";

      const step = {
        action: "upload",
        selectors: selectors.selectors,
        selector: selectors.selector,
        selectorType: selectors.selectorType,
        tagName: target.tagName,
        value: fileNames.join(", "),
        description: `Upload: ${fileNames.join(", ")}`,
        url: window.location.href,
      };

      chrome.runtime.sendMessage({ type: "RECORD_STEP", step });
      console.log("Recorded file upload step:", fileNames);
      return;
    }

    // Clear any pending debounced input
    if (inputTimers.has(target)) {
      clearTimeout(inputTimers.get(target));
      inputTimers.delete(target);
    }

    // Record immediately on change
    recordInputStep(target);
  } catch (err) {
    console.error("Error recording change:", err);
  }
}

let scrollTimeout;
/**
 * Handles scroll events and records them as steps (debounced).
 * @param {Event} event
 */
function handleScroll(event) {
  try {
    if (!window.isRecording) return;

    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const step = {
        action: "scroll",
        value: JSON.stringify({
          x: window.scrollX,
          y: window.scrollY,
        }),
        description: `Scroll to ${Math.round(window.scrollX)}, ${Math.round(window.scrollY)}`,
        url: window.location.href,
        timestamp: Date.now(),
      };

      chrome.runtime.sendMessage({ type: "RECORD_STEP", step });
    }, 1000);
  } catch (err) {
    console.error("Error recording scroll:", err);
  }
}

// Register event listeners
if (!window.__recorder_listeners_added) {
  window.addEventListener("click", handleClick, true);
  window.addEventListener("change", handleChange, true); // NEW: Capture final value
  window.addEventListener("input", handleInput, true);
  window.addEventListener("scroll", handleScroll, true);
  window.__recorder_listeners_added = true;
  console.log("Recorder event listeners registered");
}

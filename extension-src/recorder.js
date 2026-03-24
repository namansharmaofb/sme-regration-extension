// Logic for capturing user interactions and reporting them to the background

/**
 * Returns a stable CSS selector identifying the innermost overlay (modal, drawer,
 * dropdown, etc.) that contains `element`. Returns null if not in an overlay.
 * Used to record `modal_context` on each step so playback can scope its search.
 *
 * Priority for stable identifier:
 *   1. id attribute (non-dynamic)
 *   2. data-testid / data-cy / data-modal-id
 *   3. role="dialog" with aria-labelledby pointing to a stable heading
 *   4. Unique class fragment (e.g. MuiDrawer-root)
 * @param {HTMLElement} element
 * @returns {string|null}
 */
function getModalContextSelector(element) {
  const OVERLAY_ROLE_SET = new Set([
    "dialog",
    "alertdialog",
    "menu",
    "listbox",
  ]);

  let current = element ? element.parentElement : null;
  let depth = 0;
  while (current && current !== document.body && depth < 30) {
    const role = (current.getAttribute("role") || "").toLowerCase();
    const cls = current.className || "";
    const isOverlay =
      OVERLAY_ROLE_SET.has(role) ||
      current.tagName === "DIALOG" ||
      (typeof cls === "string" &&
        /(\bmodal\b|\bdrawer\b|\bpopover\b|\bdropdown-menu\b|MuiModal|MuiDrawer|MuiDialog|MuiPopover|ant-modal|ant-drawer|ant-dropdown|slds-modal)/i.test(
          cls,
        )) ||
      current.hasAttribute("data-radix-dialog-content") ||
      current.hasAttribute("data-radix-popper-content-wrapper") ||
      current.hasAttribute("data-floating-ui-portal") ||
      current.hasAttribute("data-popper-placement");

    if (isOverlay) {
      // 1. Stable ID
      if (
        current.id &&
        !/^\d|[a-f0-9]{16,}|mui-[0-9]+|:(r[0-9a-z]+):/i.test(current.id)
      ) {
        return `#${CSS.escape(current.id)}`;
      }
      // 2. data-testid / data-cy
      for (const attr of ["data-testid", "data-cy", "data-modal-id"]) {
        if (current.hasAttribute(attr)) {
          return `[${attr}="${current.getAttribute(attr)}"]`;
        }
      }
      // 3. role + aria-label
      if (role && current.getAttribute("aria-label")) {
        return `[role="${role}"][aria-label="${current.getAttribute("aria-label")}"]`;
      }
      // 4. Stable MUI/framework class
      const muiClass =
        typeof cls === "string" &&
        cls
          .split(" ")
          .find(
            (c) =>
              /^(MuiDrawer|MuiDialog|MuiModal|MuiPopover|ant-modal|ant-drawer|slds-modal)/.test(
                c,
              ) && !/css-[a-z0-9]+/.test(c),
          );
      if (muiClass) return `.${muiClass}`;
      // 5. Generic role
      if (role) return `[role="${role}"]`;
      return null;
    }
    current = current.parentElement;
    depth++;
  }
  return null;
}

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

// Track last recorded click to deduplicate MUI checkbox double-fires
let _lastRecordedClick = { target: null, promotedTarget: null, time: 0 };

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
    const rawTarget = composedPath.length > 0 ? composedPath[0] : event.target;

    // DEDUP: MUI fires click twice for one checkbox click (bubbling).
    // Skip if within 200ms and the raw targets are in an ancestor/descendant
    // relationship AND both are checkbox/radio related.
    const now = Date.now();
    if (_lastRecordedClick.target && now - _lastRecordedClick.time < 200) {
      const lastRaw = _lastRecordedClick.target;
      const isRelated =
        lastRaw === rawTarget ||
        lastRaw.contains(rawTarget) ||
        rawTarget.contains(lastRaw);

      if (isRelated) {
        // Only suppress if both involve a checkbox/radio
        const touchesCheckbox = (el) => {
          // Walk up a few levels to see if there's a checkbox nearby
          let cur = el;
          let d = 0;
          while (cur && cur !== document.body && d < 5) {
            if (
              cur.tagName === "INPUT" &&
              (cur.type === "checkbox" || cur.type === "radio")
            )
              return true;
            if (
              cur.getAttribute &&
              (cur.getAttribute("role") === "checkbox" ||
                cur.getAttribute("role") === "radio")
            )
              return true;
            cur = cur.parentElement;
            d++;
          }
          // Also check children
          if (el.querySelector)
            return !!el.querySelector(
              'input[type="checkbox"], input[type="radio"]',
            );
          return false;
        };

        if (touchesCheckbox(rawTarget) || touchesCheckbox(lastRaw)) {
          // Suppress the duplicate — mark as complete via the existing mechanism
          // (playback won't record this, so nothing to do here)
          return;
        }
      }
    }

    // Promote to interactive parent if clicking on child element
    let target = getInteractiveParent(rawTarget);

    const selectors = generateSelectors(target);
    const descriptor = getElementDescriptor(target);
    const nuanceMetadata = getElementState(target);

    // Calculate click offset relative to element
    const rect = target.getBoundingClientRect();
    const offsetX = Math.round(event.clientX - rect.left);
    const offsetY = Math.round(event.clientY - rect.top);

    // Capture the innermost modal/overlay that contains this element.
    // Playback uses this to scope element lookups when modals are nested.
    const modal_context = getModalContextSelector(target);

    // ── Category B: capture data context for wrong-data detection ───────────
    // Grab the text of the nearest table row / list item / card that surrounds
    // this element. During replay, the runner checks that key words from this
    // text still appear on the page after the click — catching cases where the
    // wrong record is opened (e.g. editing row 1 instead of row 2).
    const contextText = (function captureContextText() {
      try {
        let node = target.parentElement;
        const DEPTH_LIMIT = 12;
        let depth = 0;
        while (node && node !== document.body && depth < DEPTH_LIMIT) {
          const tag = node.tagName;
          const role = (node.getAttribute("role") || "").toLowerCase();
          if (
            tag === "TR" ||
            tag === "LI" ||
            tag === "ARTICLE" ||
            role === "row" ||
            role === "listitem" ||
            node.classList.contains("card") ||
            node.classList.contains("item") ||
            node.classList.contains("row-item")
          ) {
            // Strip the element itself (e.g. action buttons) from the text so we
            // get only the data cells, not "Edit Delete" noise.
            const clone = node.cloneNode(true);
            clone.querySelectorAll("button, [role='button'], a.action, .action-cell").forEach((el) => el.remove());
            const text = (clone.innerText || clone.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 300);
            if (text.length > 4) return text;
          }
          node = node.parentElement;
          depth++;
        }
      } catch (_) {}
      return null;
    })();
    // ────────────────────────────────────────────────────────────────────────

    // ── Category C: capture combobox field label for dropdown options ─────
    // When the user clicks an option inside a dropdown/listbox/popover, record
    // the label of the combobox input that owns the dropdown. During playback,
    // this ensures the engine re-opens the CORRECT combobox (e.g. "Account
    // Manager" vs "Ship to Plant") instead of guessing.
    const comboboxFieldLabel = (function captureComboboxFieldLabel() {
      try {
        // Only capture when clicking inside a dropdown overlay
        const overlay = getNearestOverlay(target);
        if (!overlay) return null;
        const overlayRole = (overlay.getAttribute("role") || "").toLowerCase();
        const overlayCls = overlay.className || "";
        const isDropdownOverlay =
          overlayRole === "listbox" ||
          overlayRole === "menu" ||
          /\b(dropdown|MuiMenu|MuiPopover|MuiAutocomplete|MuiPopper|react-select|selectV2-portal)\b/i.test(overlayCls) ||
          overlay.hasAttribute("data-popper-placement");
        if (!isDropdownOverlay) return null;

        // Strategy 1: Find a combobox input that has aria-expanded="true"
        const expandedCombos = Array.from(
          document.querySelectorAll('input[role="combobox"][aria-expanded="true"], input[aria-expanded="true"]')
        ).filter(isElementVisible);
        for (const cb of expandedCombos) {
          const label = getElementDescriptor(cb);
          if (label && label.length > 1 && label.length < 80) return label;
        }

        // Strategy 2: Find the combobox via aria-controls / aria-owns
        if (overlay.id) {
          const controller = document.querySelector(
            `[aria-controls="${CSS.escape(overlay.id)}"], [aria-owns="${CSS.escape(overlay.id)}"]`
          );
          if (controller) {
            const label = getElementDescriptor(controller);
            if (label && label.length > 1 && label.length < 80) return label;
          }
        }

        // Strategy 3: Find the most recently focused input (likely the trigger)
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
          const label = getElementDescriptor(active);
          if (label && label.length > 1 && label.length < 80) return label;
        }
      } catch (_) {}
      return null;
    })();
    // ────────────────────────────────────────────────────────────────────────

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
      modal_context,
      contextText: contextText || undefined,
      combobox_field_label: comboboxFieldLabel || undefined,
    };

    // Update last recorded click tracking
    _lastRecordedClick = {
      target: rawTarget,
      promotedTarget: target,
      time: now,
    };

    chrome.runtime.sendMessage({ type: "RECORD_STEP", step });
  } catch (err) {
    console.error("Error recording click:", err);
  }
}

/**
 * Handles double-clicks and records them as steps.
 * @param {MouseEvent} event
 */
function handleDblClick(event) {
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

    // Capture modal context for nested modal scoping during playback
    const modal_context = getModalContextSelector(target);

    const step = {
      action: "dblclick",
      selectors: selectors.selectors,
      selector: selectors.selector,
      selectorType: selectors.selectorType,
      tagName: target.tagName,
      description: descriptor,
      url: window.location.href,
      nuanceMetadata: nuanceMetadata,
      offsetX: offsetX,
      offsetY: offsetY,
      modal_context,
    };

    chrome.runtime.sendMessage({ type: "RECORD_STEP", step });
  } catch (err) {
    console.error("Error recording double-click:", err);
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
  window.addEventListener("dblclick", handleDblClick, true);
  window.addEventListener("change", handleChange, true); // NEW: Capture final value
  window.addEventListener("input", handleInput, true);
  window.addEventListener("scroll", handleScroll, true);
  window.__recorder_listeners_added = true;
  console.log("Recorder event listeners registered");
}

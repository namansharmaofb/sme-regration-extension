// Utility functions for recorder and playback

/**
 * Updates the visual indicator on the page to show if recording is active.
 * @param {boolean} active
 */
function updateVisualIndicator(active) {
  if (active) {
    document.body.style.border = "4px solid red";
    document.body.style.boxSizing = "border-box";
    document.body.setAttribute("data-recorder-active", "true");
  } else {
    document.body.style.border = "";
    document.body.style.boxSizing = "";
    document.body.removeAttribute("data-recorder-active");
  }
}

/**
 * Detects if an ID or class looks auto-generated (e.g. "lAIJgo", "input-12345").
 * @param {string} str
 */
function isDynamicId(str) {
  if (!str) return false;
  if (/^\d/.test(str)) return true; // Starts with digit
  if (/\d{4,}/.test(str)) return true; // Has 4+ consecutive digits
  if (/^[a-zA-Z0-9]{5,8}$/.test(str) && /[0-9]/.test(str) === false) {
    if (/[a-z]/.test(str) && /[A-Z]/.test(str)) return true;
  }
  return false;
}

function isDynamicClass(cls) {
  return isDynamicId(cls);
}

/**
 * Extracts visible text from an element, handles images and inputs.
 * @param {HTMLElement} element
 */
function getVisibleText(element) {
  if (!element) return "";
  const text = element.innerText || element.textContent;
  if (text) {
    // Normalize whitespace: replace multiple spaces/newlines with a single space
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length > 0 && normalized.length < 100) return normalized;
  }
  if (element.tagName === "IMG" && element.alt) return element.alt.trim();
  if (element.tagName === "INPUT" && element.type === "submit" && element.value)
    return element.value.trim();
  return "";
}

/**
 * Generates a human-readable description for an element.
 * @param {HTMLElement} element
 */
function getElementDescriptor(element) {
  if (!element) return "";

  if (element.getAttribute("aria-label"))
    return element.getAttribute("aria-label");

  // For inputs/textareas, prioritize associated label text
  if (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  ) {
    // 1. Label by for attribute
    if (element.id) {
      const label = document.querySelector(
        `label[for="${CSS.escape(element.id)}"]`,
      );
      if (label) {
        const labelText = getVisibleText(label);
        if (labelText) return labelText;
      }
    }
    // 2. Wrap label
    const wrapLabel = element.closest("label");
    if (wrapLabel) {
      const labelText = getVisibleText(wrapLabel);
      if (labelText) return labelText;
    }
    // 3. aria-labelledby
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) {
        const labelText = getVisibleText(labelEl);
        if (labelText) return labelText;
      }
    }
    // 4. Proximity Label (SLDS / Common Enterprise Grids)
    // Find nearest container that might hold a label
    const parentContainer = element.closest(
      ".slds-form-element, .form-group, .row",
    );
    if (parentContainer) {
      const labelText = parentContainer.querySelector(
        ".slds-form-element__label, .label, label, .slds-text-title",
      )?.innerText;
      if (labelText) {
        // Double check it's not the value itself
        const normalizedLabel = labelText.replace(/\s+/g, " ").trim();
        if (normalizedLabel && normalizedLabel !== element.value) {
          return normalizedLabel;
        }
      }
    }

    // 5. Section Header Discovery (h2/h3 in ancestors)
    // Walk up the tree to find the nearest ancestor that contains a heading
    let current = element.parentElement;
    while (current && !current.classList.contains("pageWrapper")) {
      if (
        current.classList.contains("col") ||
        current.classList.contains("form-group") ||
        current.classList.contains("row") ||
        current.classList.contains("item-details")
      ) {
        const heading = current.querySelector(
          "h1, h2, h3, .slds-text-title_caps, .heading5, .control-label",
        );
        if (heading && heading.innerText) {
          const headingText = heading.innerText.replace(/\s+/g, " ").trim();
          if (headingText && headingText !== element.value) {
            return headingText;
          }
        }
      }
      current = current.parentElement;
    }
  }

  const text = getVisibleText(element);
  if (text) return text;

  if (element.getAttribute("placeholder"))
    return element.getAttribute("placeholder");

  if (element.getAttribute("title")) return element.getAttribute("title");

  if (element.id && !isDynamicId(element.id)) return `#${element.id}`;

  if (element.getAttribute("name")) return element.getAttribute("name");

  return "";
}

/**
 * Checks if an element is visible to the user.
 * @param {HTMLElement} element
 */
function isElementVisible(element) {
  if (!element) return false;
  if (!element.isConnected) return false;

  const style = window.getComputedStyle(element);

  // Custom styled radio/checkboxes are often obscured but interactive
  const isRadioOrCheckbox =
    element.tagName === "INPUT" &&
    (element.type === "radio" || element.type === "checkbox");

  // Truly hidden if display: none
  if (style.display === "none") return false;

  // For others, if opacity:0 or visibility:hidden, we often still want to allow it if it's a radio/checkbox
  if (!isRadioOrCheckbox) {
    if (style.visibility === "hidden" || style.opacity === "0") return false;
  }

  const rect = element.getBoundingClientRect();
  // Radio buttons often have 0x0 size when hidden but labels are clicked
  if (!isRadioOrCheckbox && (rect.width === 0 || rect.height === 0)) {
    return false;
  }

  return true;
}

/**
 * Temporarily highlights an element with a red outline.
 * @param {HTMLElement} element
 */
function highlightElement(element) {
  if (!element) return;
  const originalOutline = element.style.outline;
  const originalTransition = element.style.transition;

  element.style.outline = "2px solid #ef4444";
  element.style.transition = "outline 0.2s ease-in-out";

  setTimeout(() => {
    element.style.outline = originalOutline;
    element.style.transition = originalTransition;
  }, 1000);
}

/**
 * Captures the current state of an element for nuance detection.
 * @param {HTMLElement} element
 * @returns {Object}
 */
function getElementState(element) {
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return {
    rect: {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    styles: {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
    },
    attributes: {
      "aria-label": element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      placeholder: element.getAttribute("placeholder"),
      name: element.getAttribute("name"),
    },
    text: getVisibleText(element),
  };
}

/**
 * Compares two element states and returns a list of differences (nuances).
 * @param {Object} oldState
 * @param {Object} newState
 * @returns {Array}
 */
function compareStates(oldState, newState) {
  if (!oldState || !newState) return [];
  const nuances = [];

  // 1. Position/Size Check
  const dx = Math.abs(oldState.rect.x - newState.rect.x);
  const dy = Math.abs(oldState.rect.y - newState.rect.y);
  if (dx > 20 || dy > 20) {
    nuances.push(
      `Position shifted by ${Math.round(Math.sqrt(dx * dx + dy * dy))}px`,
    );
  }

  if (
    Math.abs(oldState.rect.width - newState.rect.width) > 10 ||
    Math.abs(oldState.rect.height - newState.rect.height) > 10
  ) {
    nuances.push(
      `Size changed from ${oldState.rect.width}x${oldState.rect.height} to ${newState.rect.width}x${newState.rect.height}`,
    );
  }

  // 2. Style Check
  for (const prop in oldState.styles) {
    if (oldState.styles[prop] !== newState.styles[prop]) {
      nuances.push(
        `Style "${prop}" changed: "${oldState.styles[prop]}" -> "${newState.styles[prop]}"`,
      );
    }
  }

  // 3. Attribute Check
  for (const attr in oldState.attributes) {
    if (oldState.attributes[attr] !== newState.attributes[attr]) {
      nuances.push(
        `Attribute "${attr}" changed: "${oldState.attributes[attr]}" -> "${newState.attributes[attr]}"`,
      );
    }
  }

  // 4. Text Check
  if (oldState.text !== newState.text) {
    nuances.push(`Text changed: "${oldState.text}" -> "${newState.text}"`);
  }

  return nuances;
}

/**
 * Finds an element even if it's inside many nested Shadow DOMs.
 * @param {string} selector
 * @param {Element|Document} root
 * @returns {Element|null}
 */
function deepQuerySelector(selector, root = document) {
  const element = root.querySelector(selector);
  if (element) return element;

  // Search in all shadow roots
  const allElements = root.querySelectorAll("*");
  for (const el of allElements) {
    if (el.shadowRoot) {
      const found = deepQuerySelector(selector, el.shadowRoot);
      if (found) return found;
    }
  }

  return null;
}

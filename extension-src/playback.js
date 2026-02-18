// Engine for finding elements and executing commands during flow playback

/**
 * Verifies that an element exists or contains specific text.
 * @param {Object} step
 */
async function verifyAssertion(step) {
  const element = locateElement(step);

  if (step.action === "assertExists") {
    if (!element || !isElementVisible(element)) {
      throw new Error(
        `Assertion Failed: Element not found or not visible for: ${step.description}`,
      );
    }
    highlightElement(element);
    return true;
  }

  if (step.action === "assertText") {
    if (!element) {
      throw new Error(
        `Assertion Failed: Element not found for: ${step.description}`,
      );
    }
    const actualText = getVisibleText(element)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const expectedText = (step.selectors?.innerText || step.description || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    if (!actualText.includes(expectedText)) {
      throw new Error(
        `Assertion Failed: Expected text "${expectedText}" but found "${actualText}"`,
      );
    }
    highlightElement(element);
    return true;
  }
  return false;
}

/**
 * Safely executes querySelectorAll and returns an array of elements.
 * Prevents crashes on invalid selectors (e.g. Playwright prefixes).
 */
function safeQuerySelectorAll(selector, root = document) {
  if (!selector || typeof selector !== "string") return [];

  // Quick prevent for common invalid playwright-style selectors
  if (
    selector.startsWith("aria/") ||
    selector.startsWith("xpath/") ||
    selector.startsWith("//")
  ) {
    return [];
  }

  try {
    return Array.from(root.querySelectorAll(selector));
  } catch (e) {
    return [];
  }
}

function locateElement(step) {
  let element = null;
  // 1. Try new selector array format (or nested selectors object)
  const selectorArray = Array.isArray(step.selectors)
    ? step.selectors
    : Array.isArray(step.selectors?.selectors)
      ? step.selectors.selectors
      : null;
  if (selectorArray && selectorArray.length > 0) {
    const stepWithArray =
      selectorArray === step.selectors
        ? step
        : { ...step, selectors: selectorArray };
    element = locateElementWithSelectorArray(stepWithArray);
  }

  // 2. Try legacy single selector if array fails or is missing
  if (!element) {
    element = locateElementLegacy(step);
  }

  // 3. Try fuzzy search as last resort before giving up
  if (!element) {
    element = fuzzyFallbackSearch(step);
  }

  // 4. Try deep shadow DOM search for the main selector
  if (!element && step.target) {
    const target = step.target;
    // Don't pass prefixed ones to querySelector
    if (
      !target.startsWith("aria/") &&
      !target.startsWith("xpath/") &&
      !target.startsWith("//")
    ) {
      element = deepQuerySelector(target);
    }
  }

  return element;
}

/**
 * Locates element using new selector array format with Shadow DOM support.
 * @param {Object} step
 * @returns {HTMLElement|null}
 */
function locateElementWithSelectorArray(step) {
  const { selectors } = step;

  for (const selectorGroup of selectors) {
    const selector = Array.isArray(selectorGroup)
      ? selectorGroup[0]
      : selectorGroup;

    if (!selector || typeof selector !== "string") continue;

    try {
      let el = null;

      // ARIA Selector (Puppeteer format: "aria/Button Text")
      if (selector.startsWith("aria/")) {
        const ariaText = selector.slice(5);
        if (isGenericIconAria(ariaText)) {
          logExecution(
            `Skipping generic aria icon selector ${selector}`,
            "info",
          );
          continue;
        }
        const elements = findAllByAriaLabel(ariaText);

        // Strategy: 1. Visible and matches step description text
        // 2. Visible (only if unique match)
        // 3. Skip if ambiguous — let more specific selectors handle it
        const expectedText = (
          step.description ||
          step.selectors?.innerText ||
          ""
        )
          .toLowerCase()
          .trim();
        const visibleElements = elements.filter(isElementVisible);

        if (expectedText && expectedText.length > 2) {
          el = visibleElements.find((e) => {
            const text = getVisibleText(e).toLowerCase().trim();
            return text === expectedText || text.includes(expectedText);
          });
        }

        // If we have exactly 1 visible match, use it
        if (!el && visibleElements.length === 1) {
          el = visibleElements[0];
        }
        // If many visible matches and text didn't disambiguate, skip to let
        // more specific selectors (XPath with ID, CSS) win
        if (!el && visibleElements.length > 1) {
          logExecution(
            `Strategy ${selector} found ${visibleElements.length} visible elements, skipping ambiguous match`,
            "info",
          );
          continue;
        }

        if (el) {
          logSelectorSuccess(selector, el);
          return el;
        } else {
          logExecution(
            `Strategy ${selector} found NO matching elements`,
            "info",
          );
        }
      }
      // XPath selector
      else if (selector.startsWith("xpath/")) {
        const xpath = selector.slice(6);
        const els = getElementsByXPath(xpath);

        // Similar priority strategy for XPath
        const expectedText = (step.description || "").toLowerCase().trim();
        const visibleElements = els.filter(isElementVisible);

        if (expectedText && expectedText.length > 2) {
          el = visibleElements.find((e) => {
            const text = getVisibleText(e).toLowerCase().trim();
            return text === expectedText || text.includes(expectedText);
          });
        }

        // If unique visible match, use it
        if (!el && visibleElements.length === 1) {
          el = visibleElements[0];
        }
        // If ambiguous (multiple visible matches), skip to more specific selectors
        if (!el && visibleElements.length > 1) {
          logExecution(
            `Strategy ${selector} found ${visibleElements.length} visible elements, skipping ambiguous match`,
            "info",
          );
          continue;
        }

        if (el) {
          logSelectorSuccess(selector, el);
          return el;
        } else if (els.length > 0) {
          logExecution(
            `Strategy ${selector} found ${els.length} elements but none were visible`,
            "warning",
          );
        } else {
          logExecution(
            `Strategy ${selector} found NO matching elements`,
            "info",
          );
        }
      }
      // CSS selector (default)
      else {
        // Try normal first
        const elements = safeQuerySelectorAll(selector);

        // Strategy: 1. Visible and matches text description
        // 2. Visible
        // 3. Just the first one
        const expectedText = (step.description || "").toLowerCase().trim();

        if (expectedText && expectedText.length > 2) {
          const visibleMatches = elements.filter(isElementVisible);
          const textMatches = visibleMatches.filter((e) => {
            const descriptor = getElementDescriptor(e);
            const visibleText = getVisibleText(e);
            return (
              textMatchesExpected(expectedText, descriptor) ||
              textMatchesExpected(expectedText, visibleText)
            );
          });

          if (textMatches.length === 1) {
            el = textMatches[0];
          } else if (textMatches.length > 1) {
            logExecution(
              `Strategy ${selector} matched ${textMatches.length} elements for description "${expectedText}", skipping ambiguous match`,
              "info",
            );
            continue;
          } else if (
            isSpecificSelector(selector) &&
            visibleMatches.length === 1 &&
            step.action === "input"
          ) {
            // Only allow relaxed text match for INPUT steps (handles dynamic placeholders)
            // For CLICK steps, we must be strict about the text.
            el = visibleMatches[0];
          } else if (visibleMatches.length > 0) {
            logExecution(
              `Strategy ${selector} found ${visibleMatches.length} elements but none matched "${expectedText}"${step.action !== "input" ? " (skipping because it is a click step)" : ""}`,
              "info",
            );
          }
        }

        // If this is a generic selector and multiple visible matches exist,
        // skip it to let more specific selectors (XPath, full CSS path) win.
        if (!el) {
          const visibleList = elements.filter(isElementVisible);
          if (visibleList.length === 1) {
            el = visibleList[0];
          } else if (visibleList.length > 1) {
            logExecution(
              `Strategy ${selector} matched ${visibleList.length} visible elements, skipping ambiguous selector`,
              "info",
            );
            continue; // Force fallback to next selector (e.g. XPath)
          }
        }

        // Try deep shadow if not found
        if (!el) el = deepQuerySelector(selector);

        if (el) {
          logSelectorSuccess(selector, el);
          return el;
        } else if (elements.length > 0) {
          logExecution(
            `Strategy ${selector} found ${elements.length} elements but none were visible`,
            "warning",
          );
        } else {
          logExecution(
            `Strategy ${selector} found NO matching elements`,
            "info",
          );
        }
      }
    } catch (e) {
      logExecution(
        `Selector strategy failed: ${selector} - ${e.message}`,
        "error",
      );
    }
  }
  return null;
}

/**
 * Finds all elements by ARIA label (accessible name).
 * @param {string} ariaText
 * @returns {Array<HTMLElement>}
 */
function findAllByAriaLabel(ariaText) {
  if (!ariaText) return [];
  const normalizedSearch = ariaText.replace(/\s+/g, " ").trim().toLowerCase();
  const matches = [];

  const allElements = document.querySelectorAll("*");
  for (const el of allElements) {
    let matched = false;

    // 1. aria-label
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim().toLowerCase() === normalizedSearch) {
      matched = true;
    }

    // 2. aria-labelledby
    if (!matched) {
      const ariaLabelledBy = el.getAttribute("aria-labelledby");
      if (ariaLabelledBy) {
        const labelEl = document.getElementById(ariaLabelledBy);
        if (labelEl) {
          const labelText = getVisibleText(labelEl).trim().toLowerCase();
          if (labelText === normalizedSearch) matched = true;
        }
      }
    }

    // 3. connected label
    if (!matched && el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) {
        const labelText = getVisibleText(label).trim().toLowerCase();
        if (labelText === normalizedSearch) matched = true;
      }
    }

    // 4. Wrap label
    if (!matched) {
      const wrapLabel = el.closest("label");
      if (wrapLabel) {
        const labelText = getVisibleText(wrapLabel).trim().toLowerCase();
        if (labelText === normalizedSearch) matched = true;
      }
    }

    // 5. Role/TagName text
    if (!matched) {
      const role = el.getAttribute("role");
      const interactiveTags = ["BUTTON", "A", "SELECT", "INPUT", "TEXTAREA"];
      const interactiveRoles = [
        "button",
        "link",
        "menuitem",
        "tab",
        "option",
        "radio",
        "checkbox",
      ];
      if (
        interactiveTags.includes(el.tagName) ||
        (role && interactiveRoles.includes(role))
      ) {
        const text = getVisibleText(el)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (text === normalizedSearch) matched = true;
      }
    }

    // 6. Placeholder
    if (!matched && el.hasAttribute("placeholder")) {
      const placeholder = el
        .getAttribute("placeholder")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (placeholder === normalizedSearch) matched = true;
    }

    if (matched) matches.push(el);
  }

  return matches;
}

/**
 * Finds element by ARIA label (accessible name).
 * @param {string} ariaText
 * @returns {HTMLElement|null}
 */
function findByAriaLabel(ariaText) {
  const matches = findAllByAriaLabel(ariaText);
  return matches.find(isElementVisible) || matches[0] || null;
}

/**
 * Legacy locator for backward compatibility.
 * @param {Object} step
 * @returns {HTMLElement|null}
 */
function locateElementLegacy(step) {
  const { targets, target, selectors, selector, selectorType } = step;

  const activeTargets = [];

  // 1. Build a list of candidate locators (Normalizing new and old formats)
  if (targets && Array.isArray(targets)) {
    targets.forEach((t) => {
      if (typeof t === "object" && t.type && t.value) {
        // New structure: {type, value}
        activeTargets.push({ type: t.type, value: t.value });
      } else if (Array.isArray(t) && t.length >= 1) {
        // Transition structure: ["prefix=value", "type"]
        const parts = t[0].split("=");
        if (parts.length >= 2) {
          activeTargets.push({
            type: parts[0],
            value: t[0].slice(parts[0].length + 1),
          });
        }
      }
    });
  }

  // Handle high-level target/selector fields
  if (selector && selectorType) {
    activeTargets.unshift({ type: selectorType, value: selector });
  } else if (target && typeof target === "string") {
    if (target.includes("=")) {
      // Old Selenium style string: "type=value"
      const parts = target.split("=");
      activeTargets.unshift({
        type: parts[0],
        value: target.slice(parts[0].length + 1),
      });
    } else {
      // Raw string: check for Playwright-style prefixes
      if (target.startsWith("aria/")) {
        activeTargets.unshift({ type: "aria", value: target.slice(5) });
      } else if (target.startsWith("xpath/")) {
        activeTargets.unshift({ type: "xpath", value: target.slice(6) });
      } else if (target.startsWith("//")) {
        activeTargets.unshift({ type: "xpath", value: target });
      } else {
        // Raw string: assume CSS
        activeTargets.unshift({ type: "css", value: target });
      }
    }
  }

  // 2. Try each locator strategy
  for (const locator of activeTargets) {
    try {
      let el = null;
      const { type, value } = locator;
      const normalizedValue = normalizeSelectorValue(type, value);

      if (type === "id") {
        const elements = document.querySelectorAll(
          `[id="${CSS.escape(normalizedValue)}"]`,
        );
        for (const candidate of elements) {
          if (isElementVisible(candidate)) {
            el = candidate;
            break;
          }
        }
      } else if (type === "css" || type === "css:finder") {
        const elements = safeQuerySelectorAll(normalizedValue);
        const expectedText = (
          step.description ||
          step.selectors?.innerText ||
          ""
        )
          .toLowerCase()
          .trim();

        if (expectedText && expectedText.length > 2) {
          const visibleMatches = elements.filter(isElementVisible);
          const textMatches = visibleMatches.filter((e) => {
            const text = getElementDescriptor(e) || getVisibleText(e);
            return textMatchesExpected(expectedText, text);
          });

          if (textMatches.length === 1) {
            el = textMatches[0];
          } else if (textMatches.length > 1) {
            logExecution(
              `Legacy strategy ${type} matched ${textMatches.length} elements for text "${expectedText}", skipping ambiguous match`,
              "info",
            );
            continue;
          } else if (
            isSpecificSelector(normalizedValue) &&
            visibleMatches.length === 1
          ) {
            el = visibleMatches[0];
          } else {
            logExecution(
              `Legacy strategy ${type} found elements but none matched text "${expectedText}", skipping`,
              "info",
            );
            continue;
          }
        }

        if (!el) {
          for (const candidate of elements) {
            if (isElementVisible(candidate)) {
              el = candidate;
              break;
            }
          }
        }
      } else if (type === "aria") {
        if (isGenericIconAria(normalizedValue)) {
          logExecution(
            `Skipping generic aria icon selector aria/${normalizedValue}`,
            "info",
          );
          continue;
        }
        el = findByAriaLabel(normalizedValue);
      } else if (type === "xpath" || type.startsWith("xpath:")) {
        const els = getElementsByXPath(normalizedValue);
        if (els.length > 0) el = els[0];
      } else if (type === "linkText") {
        const links = document.getElementsByTagName("a");
        for (const link of links) {
          const lText = getVisibleText(link)
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          const vText = value.replace(/\s+/g, " ").trim().toLowerCase();
          if (lText === vText) {
            el = link;
            break;
          }
        }
      } else if (type === "name") {
        el = document.querySelector(`[name="${CSS.escape(normalizedValue)}"]`);
      } else if (type === "testId") {
        el = document.querySelector(
          `[data-testid="${CSS.escape(normalizedValue)}"], [data-cy="${CSS.escape(normalizedValue)}"], [data-test-id="${CSS.escape(normalizedValue)}"], [data-qa="${CSS.escape(normalizedValue)}"]`,
        );
      } else if (type === "placeholder") {
        el = document.querySelector(
          `[placeholder="${CSS.escape(normalizedValue)}"]`,
        );
      } else if (type === "role") {
        // Parse role: button[name='Save']
        const match = normalizedValue.match(/([a-z]+)\[name='(.+?)'\]/);
        if (match) {
          const role = match[1];
          const name = match[2];
          const candidates = document.querySelectorAll(
            role === "textbox" ? "input, textarea" : role,
          );
          for (const candidate of candidates) {
            const cName =
              candidate.getAttribute("aria-label") ||
              candidate.innerText ||
              candidate.getAttribute("alt") ||
              "";
            if (cName.trim() === name || cName.includes(name)) {
              el = candidate;
              break;
            }
          }
        }
      }

      if (el) {
        const isVisible = isElementVisible(el);
        const logMsg = `Playback: Strategy ${type}=${value} found ${el.tagName} (ID: ${el.id}, Visible: ${isVisible})`;
        chrome.storage.local
          .get("e2e_debug_logs")
          .then(({ e2e_debug_logs = [] }) => {
            e2e_debug_logs.push(`[${new Date().toISOString()}] ${logMsg}`);
            chrome.storage.local.set({ e2e_debug_logs });
          });

        if (isVisible && el.isConnected) return el;
      }
    } catch (e) {
      console.warn("Strategy failed:", locator, e.message);
    }
  }

  // Legacy Fallback — require visibility to avoid returning collapsed/hidden elements
  if (selectors && selectors.css) {
    const el = safeQuerySelectorAll(selectors.css)[0];
    if (el && el.isConnected && isElementVisible(el)) return el;
  }

  if (selector) {
    const el = safeQuerySelectorAll(selector)[0];
    if (el && el.isConnected && isElementVisible(el)) return el;
  }

  if (selectors && selectors.id) {
    const el = document.getElementById(selectors.id);
    if (el && el.isConnected && isElementVisible(el)) return el;
  }

  return fuzzyFallbackSearch(step);
}

/**
 * Normalizes selector values that may include Playwright-style prefixes.
 * @param {string} type
 * @param {string} value
 * @returns {string}
 */
function normalizeSelectorValue(type, value) {
  if (typeof value !== "string") return value;

  if (type === "aria" && value.startsWith("aria/")) {
    return value.slice(5);
  }

  if (type === "xpath" || type.startsWith("xpath:")) {
    if (value.startsWith("xpath/")) return value.slice(6);
  }

  return value;
}

function isGenericIconAria(text) {
  if (!text || typeof text !== "string") return false;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const genericIcons = new Set([
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
    "refresh",
  ]);
  return genericIcons.has(normalized);
}

function isSpecificSelector(selector) {
  if (!selector || typeof selector !== "string") return false;
  if (selector.includes("#")) return true;
  return /\[(data-testid|data-cy|data-test-id|data-qa|aria-label|name)=/i.test(
    selector,
  );
}

function normalizeTextForMatch(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeTextLoose(text) {
  return stripIconWords(
    normalizeTextForMatch(text)
      .replace(/[\d()]+/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function textMatchesExpected(expected, actual) {
  if (!expected || !actual) return false;
  const e = normalizeTextForMatch(expected);
  const a = normalizeTextForMatch(actual);
  if (!e || !a) return false;

  if (a === e || a.includes(e) || e.includes(a)) return true;

  const eLoose = normalizeTextLoose(expected);
  const aLoose = normalizeTextLoose(actual);
  if (!eLoose || !aLoose) return false;
  return (
    aLoose === eLoose || aLoose.includes(eLoose) || eLoose.includes(aLoose)
  );
}

function stripIconWords(text) {
  if (!text) return "";
  const iconWords = [
    "chevron_right",
    "chevron_left",
    "expand_more",
    "expand_less",
    "file_download",
    "file_upload",
    "west",
    "east",
    "north",
    "south",
    "menu",
    "more_vert",
    "more_horiz",
    "close",
    "search",
    "filter_list",
    "edit",
    "delete",
    "download",
    "upload",
    "refresh",
  ];
  const pattern = new RegExp(`\\b(${iconWords.join("|")})\\b`, "g");
  return text.replace(pattern, "").replace(/\s+/g, " ").trim();
}

/**
 * Fuzzy fallback search for elements.
 * @param {Object} step
 * @returns {HTMLElement|null}
 */
function fuzzyFallbackSearch(step) {
  // --- AGGRESSIVE FUZZY FALLBACK (Manager Demo Mode) ---
  // If all specific locators fail, search for any clickable element with matching text
  const searchText = step.description || step.value || "";
  if (searchText && searchText.length > 2 && searchText.length < 50) {
    const allElements = document.querySelectorAll(
      "button, a, div[role='button'], input[type='submit'], span",
    );
    for (const el of allElements) {
      const elText = getVisibleText(el)
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const searchLower = searchText.replace(/\s+/g, " ").trim().toLowerCase();
      if (
        (elText === searchLower || elText.includes(searchLower)) &&
        isElementVisible(el)
      ) {
        console.log(`Fuzzy match found: '${elText}' matches '${searchLower}'`);
        return el;
      }
    }
  }

  // --- DEEP SHADOW DOM SEARCH ---
  // If we still haven't found it, try recursively searching all shadow roots
  const selectors =
    step.selectors || (step.selector ? { css: step.selector } : null);
  if (selectors && selectors.css) {
    console.log(`Deep searching Shadows for: ${selectors.css}`);
    const shadowEl = deepQuerySelector(selectors.css);
    if (shadowEl && isElementVisible(shadowEl)) return shadowEl;
  }

  console.log(
    `Locate failed for step. Selectors:`,
    step.selectors || step.selector,
  );
  return null;
}

/**
 * Logs successful selector match.
 * @param {string} selector
 * @param {HTMLElement} element
 */
function logSelectorSuccess(selector, element) {
  const isVisible = isElementVisible(element);
  const logMsg = `Playback: Selector "${selector}" found ${element.tagName} (ID: ${element.id}, Visible: ${isVisible})`;
  chrome.storage.local.get("e2e_debug_logs").then(({ e2e_debug_logs = [] }) => {
    e2e_debug_logs.push(`[${new Date().toISOString()}] ${logMsg}`);
    chrome.storage.local.set({ e2e_debug_logs });
  });
}

/**
 * Recursively searches for an element matching the selector in all open Shadow DOMs.
 * @param {string} selector
 * @param {Node} root
 * @returns {HTMLElement|null}
 */
function deepQuerySelector(selector, root = document) {
  // Check current scope
  let el = null;
  try {
    el = root.querySelector(selector);
  } catch (e) {}

  if (el) return el;

  // Find all elements with shadow roots in this scope
  // Note: This is expensive, but necessary for "Demo Mode" resilience
  const elements = root.querySelectorAll("*");
  for (const element of elements) {
    if (element.shadowRoot) {
      const found = deepQuerySelector(selector, element.shadowRoot);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Sends a log message to the background (which forwards it to popup).
 * @param {string} text
 * @param {string} level
 */
function logExecution(text, level = "info") {
  chrome.runtime
    .sendMessage({ type: "LOG_MESSAGE", text, level })
    .catch(() => {});

  // Also log to e2e_debug_logs for runner visibility
  chrome.storage.local.get("e2e_debug_logs").then(({ e2e_debug_logs = [] }) => {
    e2e_debug_logs.push(`[${new Date().toISOString()}] Playback: ${text}`);
    chrome.storage.local.set({ e2e_debug_logs });
  });
}

let currentlyExecutingIndex = -1;

/**
 * Detects and logs nuances (differences in element state) between recording and playback.
 * @param {HTMLElement} element
 * @param {Object} step
 */
function detectNuances(element, step) {
  if (!step.nuanceMetadata) return;

  const currentState = getElementState(element);
  const nuances = compareStates(step.nuanceMetadata, currentState);

  if (nuances.length > 0) {
    const message = nuances.join(", ");
    logExecution(`Nuances Detected: ${message}`, "warning");
    chrome.runtime
      .sendMessage({
        type: "BUG_DETECTED",
        bug: {
          stepIndex: currentlyExecutingIndex,
          type: "nuance",
          message: message,
        },
      })
      .catch(() => {});
    console.log(
      `[Nuance Detection] Step ${currentlyExecutingIndex + 1}:`,
      nuances,
    );
  }
}

function isDecorativeElement(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return ["I", "SVG", "PATH", "USE", "SPAN"].includes(tag);
}

function getClickableAncestor(el, maxDepth = 5) {
  let current = el;
  let depth = 0;
  while (current && depth < maxDepth) {
    const tag = (current.tagName || "").toUpperCase();
    const role = current.getAttribute && current.getAttribute("role");
    if (tag === "BUTTON" || tag === "A") return current;
    if (role === "button" || role === "link") return current;
    if (current.hasAttribute && current.hasAttribute("onclick")) return current;
    if (typeof current.tabIndex === "number" && current.tabIndex >= 0)
      return current;
    current = current.parentElement;
    depth++;
  }
  return null;
}

/**
 * Executes a single command on the page.
 * @param {Object} step
 * @param {number} index
 */
async function executeSingleStep(step, index) {
  if (currentlyExecutingIndex === index) return;
  currentlyExecutingIndex = index;

  logExecution(`Step ${index + 1} starting: ${JSON.stringify(step)}`, "info");

  try {
    let element = null;
    const maxAttempts = 40; // Increased to 10 seconds total (40 * 250ms)
    const waitTime = 250;

    if (step.action !== "scroll") {
      for (let i = 0; i < maxAttempts; i++) {
        element = locateElement(step);
        if (element && isElementVisible(element)) break;
        element = null;
        await new Promise((r) => setTimeout(r, waitTime));
      }

      if (!element) {
        throw new Error(
          `Element not found or not visible for step:${index + 1} (${step.action})`,
        );
      }
      logExecution(
        `Step ${index + 1}: Element found, executing ${step.action}`,
        "success",
      );

      // Perform nuance detection
      detectNuances(element, step);
    }

    if (step.action === "click") {
      const clickableParent = isDecorativeElement(element)
        ? getClickableAncestor(element)
        : null;
      if (clickableParent && clickableParent !== element) {
        element = clickableParent;
      }

      // SETTLE TIME: Give frameworks a moment to update DOM before interacting
      await new Promise((r) => setTimeout(r, 400));

      element.scrollIntoView({
        behavior: "auto",
        block: "center",
        inline: "center",
      });
      await new Promise((r) => setTimeout(r, 100));
      highlightElement(element);

      const { offsetX, offsetY } = step;
      const rect = element.getBoundingClientRect();
      const clientX =
        rect.left +
        (clickableParent ? rect.width / 2 : offsetX || rect.width / 2);
      const clientY =
        rect.top +
        (clickableParent ? rect.height / 2 : offsetY || rect.height / 2);

      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        buttons: 1,
      };

      // Dispatch full sequence including PointerEvents for modern frameworks (MUI, etc.)
      try {
        element.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...eventOptions,
            pointerType: "mouse",
          }),
        );
        element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
        element.dispatchEvent(
          new PointerEvent("pointerup", {
            ...eventOptions,
            pointerType: "mouse",
          }),
        );
        element.dispatchEvent(new MouseEvent("mouseup", eventOptions));

        // Use standard click for basic behavior
        element.click();

        // Some libraries only listen for this specific event
        element.dispatchEvent(new MouseEvent("click", eventOptions));
      } catch (e) {
        console.warn("Event dispatch failed, falling back to basic click", e);
        element.click();
      }

      console.log(
        `Executed step ${index + 1}: Click at (${clientX}, ${clientY}) on ${getElementDescriptor(element)}`,
      );
      logExecution(
        `Step ${index + 1}: Click executed on ${getElementDescriptor(element)} at (${clientX}, ${clientY})`,
        "success",
      );

      // Some frameworks need a bit more time to process the click and update state (e.g. dropdowns)
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "STEP_COMPLETE", stepIndex: index });
      }, 1200);
    } else if (step.action === "input") {
      // SETTLE TIME
      await new Promise((r) => setTimeout(r, 300));

      element.scrollIntoView({
        behavior: "auto",
        block: "center",
        inline: "center",
      });

      // If we found a LABEL, redirect to its control (the actual input)
      if (element.tagName === "LABEL" && element.control) {
        logExecution(
          `Redirecting input action from LABEL to its control: ${element.control.tagName}`,
          "info",
        );
        element = element.control;
      }

      element.focus();
      highlightElement(element);
      await new Promise((r) => setTimeout(r, 100));

      try {
        if (
          element.tagName === "INPUT" &&
          (element.type === "radio" || element.type === "checkbox")
        ) {
          element.checked = true;
          element.dispatchEvent(new Event("click", { bubbles: true }));
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          // React/Angular Support: Directly set value property to bypass tracking wrapper
          const prototype =
            element instanceof HTMLTextAreaElement
              ? window.HTMLTextAreaElement.prototype
              : element instanceof HTMLSelectElement
                ? window.HTMLSelectElement.prototype
                : element instanceof HTMLInputElement
                  ? window.HTMLInputElement.prototype
                  : null;

          if (prototype) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              prototype,
              "value",
            ).set;
            nativeInputValueSetter.call(element, step.value || "");

            // Dispatch full event sequence for frameworks
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            // Fallback for custom components or labels that don't have a control
            element.value = step.value || "";
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        const { e2e_debug_logs = [] } =
          await chrome.storage.local.get("e2e_debug_logs");
        e2e_debug_logs.push(
          `[${new Date().toISOString()}] Playback: Input "${step.value}" into ${element.tagName} (ID: ${element.id}) successful`,
        );
        await chrome.storage.local.set({ e2e_debug_logs });
      } catch (e) {
        const { e2e_debug_logs = [] } =
          await chrome.storage.local.get("e2e_debug_logs");
        e2e_debug_logs.push(
          `[${new Date().toISOString()}] Playback: Input error on ${element.tagName}: ${e.message}`,
        );
        await chrome.storage.local.set({ e2e_debug_logs });
        throw e;
      }

      // Simulate key events (some frameworks listen for these)
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      element.blur();

      console.log(`Executed step ${index + 1}: Input "${step.value}"`);
      // Add settle time for input to allow frameworks to process changes
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "STEP_COMPLETE", stepIndex: index });
      }, 500);
    } else if (step.action === "scroll") {
      try {
        const pos = JSON.parse(step.value || '{"x":0,"y":0}');
        logExecution(
          `Step ${index + 1}: Scrolling to ${pos.x}, ${pos.y}...`,
          "info",
        );
        window.scrollTo({ left: pos.x, top: pos.y, behavior: "smooth" });
        console.log(`Executed step ${index + 1}: Scroll to ${pos.x}, ${pos.y}`);

        // Use a more defensive approach to ensure STEP_COMPLETE is sent
        setTimeout(() => {
          try {
            logExecution(
              `Step ${index + 1}: Scroll complete. Sending STEP_COMPLETE message...`,
              "info",
            );
            console.log(
              `[Playback] Sending STEP_COMPLETE for step ${index + 1}`,
            );
            chrome.runtime.sendMessage(
              {
                type: "STEP_COMPLETE",
                stepIndex: index,
              },
              (response) => {
                if (chrome.runtime.lastError) {
                  logExecution(
                    `Error sending STEP_COMPLETE: ${chrome.runtime.lastError.message}`,
                    "error",
                  );
                } else {
                  logExecution(`STEP_COMPLETE sent successfully.`, "debug");
                }
              },
            );
          } catch (err) {
            console.error("Failed to send STEP_COMPLETE for scroll:", err);
          }
        }, 1000);
      } catch (e) {
        console.error("Error in scroll action:", e);
        try {
          logExecution(
            `Step ${index + 1}: Scroll failed but continuing.`,
            "warning",
          );
          chrome.runtime.sendMessage({
            type: "STEP_COMPLETE",
            stepIndex: index,
          });
        } catch (err) {
          console.error(
            "Failed to send STEP_COMPLETE after scroll error:",
            err,
          );
        }
      }
    }
  } catch (err) {
    if (err.message.includes("Element not found")) {
      // In multi-frame pages, only one frame has the element.
      // Log to debug logs so the runner can see what happened.
      console.log(
        `Step ${index + 1}: Element not found in this frame (${window.location.href})`,
      );
      logExecution(
        `Step ${index + 1}: Element not found/not visible in frame ${window.location.href}`,
        "warning",
      );
    } else {
      console.error(`Error executing step ${index + 1}:`, err);
      chrome.runtime
        .sendMessage({
          type: "BUG_DETECTED",
          bug: {
            stepIndex: index,
            type: "error",
            message: err.message,
          },
        })
        .catch(() => {});
      chrome.runtime.sendMessage({
        type: "STEP_ERROR",
        error: err.message,
        stepIndex: index,
      });
    }
  }
}

/**
 * Captures a simplified ARIA snapshot of the page for extension-side failure reporting.
 */
function captureAriaSnapshotContent() {
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      el.offsetWidth > 0 &&
      el.offsetHeight > 0
    );
  };

  const getAriaRole = (el) => {
    return el.getAttribute("role") || el.tagName.toLowerCase() || "generic";
  };

  const getAriaName = (el) => {
    // Priority: aria-label -> aria-labelledby -> title -> alt (for images) -> inner text
    const label = el.getAttribute("aria-label");
    if (label) return label;

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.innerText.trim();
    }

    const title = el.getAttribute("title");
    if (title) return title;

    if (el.tagName === "IMG") {
      const alt = el.getAttribute("alt");
      if (alt) return alt;
    }

    // Capture first line of text or truncated text
    return (el.innerText || "").split("\n")[0].trim().substring(0, 100);
  };

  const walk = (node, depth = 0) => {
    if (!node || node.nodeType !== 1 || !isVisible(node) || depth > 15)
      return null;

    // Skip technical elements
    const tag = node.tagName;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "META", "LINK"].includes(tag))
      return null;

    const snapshot = {
      role: getAriaRole(node),
      name: getAriaName(node),
    };

    if (node.children && node.children.length > 0) {
      const children = Array.from(node.children)
        .map((c) => walk(c, depth + 1))
        .filter(Boolean);
      if (children.length > 0) snapshot.children = children;
    }

    return snapshot;
  };

  try {
    return walk(document.body);
  } catch (err) {
    console.error("Failed to capture ARIA snapshot:", err);
    return { role: "error", name: err.message };
  }
}

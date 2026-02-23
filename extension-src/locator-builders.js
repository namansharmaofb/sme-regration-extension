// Locator building logic for generating robust Selenium-compatible selectors

/**
 * Generates an XPath for an element.
 * @param {HTMLElement} element
 */
function getXPath(element) {
  try {
    if (!element) return "";
    if (element.id && !isDynamicId(element.id))
      return `//*[@id="${element.id}"]`;
    if (element === document.body) return "/html/body";
    if (
      !element.parentNode ||
      element.parentNode.nodeType !== Node.ELEMENT_NODE
    )
      return "";

    let ix = 0;
    const siblings = element.parentNode.childNodes;
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === element) {
        const parentPath = getXPath(element.parentNode);
        return parentPath
          ? `${parentPath}/${element.tagName.toLowerCase()}[${ix + 1}]`
          : "";
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
        ix++;
      }
    }
  } catch (e) {
    return "";
  }
  return "";
}

/**
 * Generates an absolute full XPath from root, ignoring IDs.
 * This is the "Nuclear Option" for targeting.
 */
function getFullXPath(element) {
  if (!element) return "";
  if (element.tagName.toLowerCase() === "html") return "/html";
  if (element === document.body) return "/html/body";

  let ix = 0;
  if (!element.parentNode) return "";

  const siblings = element.parentNode.childNodes;
  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (sibling === element) {
      return `${getFullXPath(element.parentNode)}/${element.tagName.toLowerCase()}[${ix + 1}]`;
    }
    if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
      ix++;
    }
  }
  return "";
}

/**
 * Generates selectors in Chrome DevTools Recorder format.
 * 12 strategies in priority order — no post-hoc reordering needed.
 * @param {HTMLElement} element
 * @returns {Object} Selector object with arrays and metadata
 */
function generateSelectors(element) {
  if (!element || element.nodeType !== 1) return null;

  const selectors = []; // Array of [selector] arrays — built in priority order

  // ── 1. data-testid / data-cy / data-test / data-qa ─────────────────
  // Most precise — explicitly set for testing
  const testAttrs = ["data-testid", "data-cy", "data-test", "data-qa"];
  for (const attr of testAttrs) {
    if (element.hasAttribute(attr)) {
      const value = element.getAttribute(attr);
      if (value && !isDynamic(value)) {
        selectors.push([`[${attr}="${value.replace(/"/g, '\\"')}"]`]);
      }
    }
  }

  // ── 2. Stable ID ───────────────────────────────────────────────────
  if (element.id && !isDynamic(element.id)) {
    selectors.push([`#${CSS.escape(element.id)}`]);
  }

  // ── 3. Name attribute (critical for forms) ─────────────────────────
  if (element.hasAttribute("name")) {
    const name = element.getAttribute("name");
    if (name && !isDynamic(name)) {
      const tag = element.tagName.toLowerCase();
      selectors.push([`${tag}[name="${name.replace(/"/g, '\\"')}"]`]);
    }
  }

  // ── 4. Placeholder (for inputs — very specific) ────────────────────
  // Skip short/dynamic placeholders that may be typed content (React-Select, etc.)
  if (element.hasAttribute("placeholder")) {
    const placeholder = element.getAttribute("placeholder");
    if (
      placeholder &&
      placeholder.trim().length >= 3 &&
      !/^\d+$/.test(placeholder.trim()) && // Skip pure numbers
      placeholder.trim().length < 100 // Skip absurdly long placeholders
    ) {
      selectors.push([`[placeholder="${placeholder.replace(/"/g, '\\"')}"]`]);
    }
  }

  // ── 5. ARIA (role + accessible name) ───────────────────────────────
  // Placed after attr-based selectors because ARIA labels can match
  // multiple elements (e.g., section header AND the input inside it)
  const ariaSelector = buildAriaSelector(element);
  if (ariaSelector) {
    selectors.push([ariaSelector]);
  }

  // ── 6. XPath text match (tag + text — very specific) ───────────────
  const text = getVisibleText(element).replace(/\s+/g, " ").trim();
  if (
    text &&
    text.length > 0 &&
    text.length < 50 &&
    !text.includes("'") &&
    !isGenericIconText(text)
  ) {
    const tag = element.tagName.toLowerCase();
    selectors.push([`xpath///${tag}[normalize-space(.)='${text}']`]);
    if (text.length > 3) {
      selectors.push([
        `xpath///${tag}[contains(normalize-space(.), '${text}')]`,
      ]);
    }
  }

  // ── 7. Alt / Title attributes ──────────────────────────────────────
  if (element.hasAttribute("alt")) {
    const alt = element.getAttribute("alt");
    if (alt && alt.trim().length > 0 && alt.length < 80 && !isDynamic(alt)) {
      selectors.push([
        `${element.tagName.toLowerCase()}[alt="${alt.replace(/"/g, '\\"')}"]`,
      ]);
    }
  }
  if (element.hasAttribute("title")) {
    const title = element.getAttribute("title");
    if (
      title &&
      title.trim().length > 0 &&
      title.length < 80 &&
      !isDynamic(title)
    ) {
      selectors.push([
        `${element.tagName.toLowerCase()}[title="${title.replace(/"/g, '\\"')}"]`,
      ]);
    }
  }

  // ── 8. Href / Src (for links and images with stable URLs) ──────────
  if (element.tagName === "A" && element.hasAttribute("href")) {
    const href = element.getAttribute("href");
    if (href && isStableUrl(href)) {
      selectors.push([`a[href="${href.replace(/"/g, '\\"')}"]`]);
    }
  }
  if (element.tagName === "IMG" && element.hasAttribute("src")) {
    const src = element.getAttribute("src");
    if (src && isStableUrl(src)) {
      selectors.push([`img[src="${src.replace(/"/g, '\\"')}"]`]);
    }
  }

  // ── 9. Smart CSS selector (stable attrs + limited classes) ─────────
  const css = buildSelector(element);
  if (css) {
    selectors.push([css]);
  }

  // ── 10. nth-of-type within parent (controlled positional fallback) ─
  const nthSelector = buildNthSelector(element);
  if (nthSelector) {
    selectors.push([nthSelector]);
  }

  // ── 11. Full CSS path fallback ─────────────────────────────────────
  const cssPath = buildCssPath(element);
  if (cssPath && cssPath !== css) {
    selectors.push([cssPath]);
  }

  // ── 12. XPath fallback (absolute path — last resort) ───────────────
  const xpath = getXPath(element);
  if (xpath) {
    selectors.push([`xpath//${xpath}`]);
  }

  // Build the result object
  const primary = selectors.length > 0 ? selectors[0][0] : css || xpath;

  return {
    selectors: selectors,
    selector: primary,
    selectorType: getSelectorType(primary),
    css: css,
    xpath: xpath,
    id: element.id && !isDynamic(element.id) ? element.id : null,
    attributes: {
      "data-testid": element.getAttribute("data-testid"),
      "data-cy": element.getAttribute("data-cy"),
      "data-test": element.getAttribute("data-test"),
      "data-qa": element.getAttribute("data-qa"),
      "aria-label": element.getAttribute("aria-label"),
      alt: element.getAttribute("alt"),
      title: element.getAttribute("title"),
      name: element.getAttribute("name"),
      placeholder: element.getAttribute("placeholder"),
      role: element.getAttribute("role"),
      href: element.tagName === "A" ? element.getAttribute("href") : null,
      src: element.tagName === "IMG" ? element.getAttribute("src") : null,
    },
    innerText: text || "",
  };
}

/**
 * Builds an ARIA selector — the "super-strategy" combining:
 *   - Role + accessible name (e.g. aria/button[Submit])
 *   - Label-based (label[for], wrapping label, aria-labelledby)
 *   - Visible text for interactive elements
 * Format: "aria/Submit" or "aria/button[Submit Order]"
 * @param {HTMLElement} element
 * @returns {string|null}
 */
function buildAriaSelector(element) {
  // 1. Get accessible name from getElementDescriptor (handles labels, aria-label, text, etc.)
  let accessibleName = getElementDescriptor(element);

  if (
    !accessibleName ||
    accessibleName.trim().length === 0 ||
    accessibleName.length >= 80
  ) {
    return null;
  }

  const finalName = accessibleName.replace(/\s+/g, " ").trim();
  if (isGenericIconText(finalName)) return null;

  // 2. Try to determine the ARIA role for a richer selector
  const role = getAriaRole(element);

  // If we have a meaningful role, include it: aria/button[Submit]
  if (role) {
    return `aria/${role}[${finalName}]`;
  }

  // Otherwise just use the name: aria/Submit
  return `aria/${finalName}`;
}

/**
 * Determines the effective ARIA role for an element.
 * Returns the explicit role attribute or the implicit role from the tag.
 * @param {HTMLElement} element
 * @returns {string|null}
 */
function getAriaRole(element) {
  // Explicit role attribute takes priority
  const explicitRole = element.getAttribute("role");
  if (explicitRole) return explicitRole;

  // Implicit roles from HTML semantics
  const tag = element.tagName;
  const type = (element.getAttribute("type") || "").toLowerCase();

  const implicitRoles = {
    BUTTON: "button",
    A: "link",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    ASIDE: "complementary",
    FORM: "form",
    TABLE: "table",
    UL: "list",
    OL: "list",
    LI: "listitem",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    IMG: "img",
  };

  if (tag === "INPUT") {
    const inputRoles = {
      checkbox: "checkbox",
      radio: "radio",
      range: "slider",
      search: "searchbox",
      email: "textbox",
      tel: "textbox",
      url: "textbox",
      text: "textbox",
      password: "textbox",
      number: "spinbutton",
    };
    return inputRoles[type] || "textbox";
  }

  return implicitRoles[tag] || null;
}

/**
 * Checks if a URL is stable (not dynamic/session-specific).
 * @param {string} url
 * @returns {boolean}
 */
function isStableUrl(url) {
  if (!url || typeof url !== "string") return false;
  // Skip very long URLs, data URIs, blob URIs, and javascript: URIs
  if (url.length > 150) return false;
  if (url.startsWith("data:")) return false;
  if (url.startsWith("blob:")) return false;
  if (url.startsWith("javascript:")) return false;
  // Skip URLs with tokens, session IDs, or random hashes
  if (/[?&](token|session|sid|auth|nonce|_t)=/i.test(url)) return false;
  if (/[0-9a-f]{16,}/i.test(url)) return false;
  // Skip # anchors that look dynamic
  if (/#[0-9a-f]{8,}/i.test(url)) return false;
  return true;
}

/**
 * Builds a nth-of-type selector scoped to the parent element.
 * e.g. "div > button:nth-of-type(2)"
 * Only emitted when there are multiple siblings of the same tag.
 * @param {HTMLElement} element
 * @returns {string|null}
 */
function buildNthSelector(element) {
  if (!element || !element.parentElement) return null;
  const parent = element.parentElement;
  const tag = element.tagName.toLowerCase();
  const sameTagSiblings = Array.from(parent.children).filter(
    (c) => c.tagName === element.tagName,
  );

  // Only useful when there are multiple siblings of the same type
  if (sameTagSiblings.length <= 1) return null;

  const index = sameTagSiblings.indexOf(element) + 1;
  let parentSelector = "";

  // Try to scope to a stable parent
  if (parent.id && !isDynamic(parent.id)) {
    parentSelector = `#${CSS.escape(parent.id)}`;
  } else if (parent.getAttribute("data-testid")) {
    parentSelector = `[data-testid="${parent.getAttribute("data-testid")}"]`;
  } else {
    parentSelector = parent.tagName.toLowerCase();
  }

  return `${parentSelector} > ${tag}:nth-of-type(${index})`;
}

/**
 * Gets the selector type from a selector string.
 * @param {string} selector
 * @returns {string}
 */
function getSelectorType(selector) {
  if (!selector) return "css";
  if (selector.startsWith("aria/")) return "aria";
  if (selector.startsWith("xpath/")) return "xpath";
  if (selector.startsWith("#")) return "id";
  if (selector.includes("[data-testid")) return "testId";
  if (selector.includes("[data-cy")) return "testId";
  if (selector.includes("[data-test")) return "testId";
  if (selector.includes("[data-qa")) return "testId";
  if (selector.includes("[name=")) return "name";
  if (selector.includes("[placeholder=")) return "placeholder";
  if (selector.includes("[alt=")) return "alt";
  if (selector.includes("[title=")) return "title";
  if (selector.includes("[href=")) return "href";
  if (selector.includes("[src=")) return "src";
  if (selector.includes(":nth-of-type")) return "nth";
  return "css";
}

/* ---------------- helpers ---------------- */

function isDynamic(value) {
  if (typeof value !== "string") return true;
  // Ignore purely numeric long strings or hex-like strings
  if (/^[0-9a-f]{16,}$/.test(value)) return true;

  // React / MUI dynamic IDs
  if (/^:(r[0-9a-z]*):$/.test(value)) return true;
  if (/mui-[0-9]+/.test(value)) return true;

  // Dynamic Popper/Portal IDs with random suffix
  if (/(popper|modal|dialog|select|menu)-[a-zA-Z0-9]{8,}/i.test(value)) {
    const parts = value.split("-");
    const suffix = parts[parts.length - 1];
    if (/[A-Z]/.test(suffix) && /[a-z]/.test(suffix)) return true;
    if (/[0-9]/.test(suffix) && /[a-zA-Z]/.test(suffix)) return true;
  }

  // Allow common stable prefixes
  if (/^(mui|btn|nav|list|item|cell)-/i.test(value)) return false;
  return /\d{5,}|uuid|random|test-?id|tfid-/i.test(value);
}

function isGenericIconText(text) {
  if (!text || typeof text !== "string") return false;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const iconWords = new Set([
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
    "add",
    "remove",
    "search",
    "filter_list",
    "edit",
    "delete",
    "download",
    "upload",
    "refresh",
  ]);

  // Single icon word
  if (iconWords.has(normalized)) return true;

  // If text is made only of icon words, treat as generic
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length > 0 && parts.every((p) => iconWords.has(p))) return true;

  return false;
}

function isDynamicId(id) {
  return isDynamic(id);
}

function isDynamicClass(cls) {
  return isDynamic(cls);
}

function buildCssPath(el) {
  const path = [];

  while (el && el.nodeType === 1 && el !== document.body) {
    let selector = el.tagName.toLowerCase();

    if (el.className) {
      const cls = el.className.split(" ").filter(Boolean).slice(0, 2).join(".");
      if (cls) selector += "." + cls;
    }

    const siblings = Array.from(el.parentNode.children).filter(
      (e) => e.tagName === el.tagName,
    );

    if (siblings.length > 1) {
      selector += `:nth-child(${Array.from(el.parentNode.children).indexOf(el) + 1})`;
    }

    path.unshift(selector);
    el = el.parentNode;
  }

  return path.join(" > ");
}

function buildXPath(el) {
  let path = "";

  while (el && el.nodeType === 1) {
    let index = 1;
    let sib = el.previousSibling;

    while (sib) {
      if (sib.nodeType === 1 && sib.tagName === el.tagName) index++;
      sib = sib.previousSibling;
    }

    path = `/${el.tagName.toLowerCase()}[${index}]` + path;
    el = el.parentNode;
  }

  return path;
}

/**
 * Builds a CSS selector for an element.
 * @param {HTMLElement} element
 */
function buildSelector(element) {
  if (!element) return "";

  if (element.id && !isDynamicId(element.id)) {
    return `#${CSS.escape(element.id)}`;
  }

  const stableAttrs = [
    "data-testid",
    "data-cy",
    "data-test-id",
    "data-qa",
    "name",
    "role",
    "placeholder",
    "aria-label",
  ];
  for (const attr of stableAttrs) {
    if (element.hasAttribute(attr)) {
      const val = element.getAttribute(attr);
      if (val && !isDynamicId(val)) {
        return `${element.tagName.toLowerCase()}[${attr}="${val}"]`;
      }
    }
  }

  let path = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 5) {
    let selector = current.nodeName.toLowerCase();

    if (current.className && typeof current.className === "string") {
      const classes = current.className.trim().split(/\s+/);
      const stableClasses = classes.filter(
        (cls) => cls && !isDynamicClass(cls),
      );
      if (stableClasses.length > 0) {
        selector += `.${stableClasses
          .slice(0, 2)
          .map((cls) => CSS.escape(cls))
          .join(".")}`;
      }
    }

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child) => child.nodeName === current.nodeName,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;

    if (current && current.id && !isDynamicId(current.id)) {
      path.unshift(`#${CSS.escape(current.id)}`);
      break;
    }

    let foundStableAttr = false;
    for (const attr of stableAttrs) {
      if (current && current.hasAttribute(attr)) {
        const val = current.getAttribute(attr);
        if (val && !isDynamicId(val)) {
          path.unshift(`${current.tagName.toLowerCase()}[${attr}="${val}"]`);
          foundStableAttr = true;
          break;
        }
      }
    }
    if (foundStableAttr) break;
  }

  return path.join(" > ");
}

/**
 * Finds all elements matching an XPath.
 * @param {string} xpath
 */
function getElementsByXPath(xpath) {
  const result = [];
  try {
    const nodes = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    for (let i = 0; i < nodes.snapshotLength; i++) {
      result.push(nodes.snapshotItem(i));
    }
  } catch (err) {}
  return result;
}

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

  // ── 2b. Radio / checkbox type+value (very stable for option groups) ─
  if (
    element.tagName === "INPUT" &&
    (element.type === "radio" || element.type === "checkbox")
  ) {
    const val = element.getAttribute("value");
    if (val && !isDynamic(val) && val.length < 60) {
      selectors.push([
        `input[type="${element.type}"][value="${val.replace(/"/g, '\\"')}"]`,
      ]);
    }
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

  // ── 6b. Any data-* / aria-* attribute scan ─────────────────────────
  // Katalon-style: scan ALL attributes for stable custom data- attributes
  // that the developer may have set (data-field, data-key, data-column, etc.)
  const anyAttrSelector = buildAnyAttributeSelector(element);
  if (anyAttrSelector) {
    selectors.push([anyAttrSelector]);
  }

  // ── 6c. Label-to-input XPath ────────────────────────────────────────
  // For inputs: "//label[text()='Email']/following::input[1]" — very stable
  const labelXPath = buildLabelXPath(element);
  if (labelXPath) {
    selectors.push([labelXPath]);
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

  // ── 10b. Relative XPath from stable ancestor ─────────────────────
  // Katlon-style: anchors to nearest ancestor with stable ID/testid,
  // then relative path down. Far more durable than absolute XPath.
  const relXPath = buildRelativeXPathFromAncestor(element);
  if (relXPath) {
    selectors.push([relXPath]);
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
  // We no longer block generic icon text here because if it's the ONLY thing we found via getElementDescriptor,
  // it's better than an absolute XPath. The priority is handled by the caller.

  // 2. Try to determine the ARIA role for a richer selector
  const role = getAriaRole(element);

  // 3. Nested selector for MUI overlays
  const overlay = getNearestOverlay(element);
  if (overlay && overlay !== element) {
    const overlayName = getElementDescriptor(overlay);
    const overlayRole = getAriaRole(overlay);
    if (overlayName && overlayName.length < 50) {
      const overlaySelector = overlayRole
        ? `aria/${overlayRole}[${overlayName.replace(/\s+/g, " ").trim()}]`
        : `aria/${overlayName.replace(/\s+/g, " ").trim()}`;

      const elementSelector = role
        ? `aria/${role}[${finalName}]`
        : `aria/${finalName}`;

      return `${overlaySelector} >> ${elementSelector}`;
    }
  }

  // If we have a meaningful role, include it: aria/button[Submit]
  // Guard 1: Pure icon glyphs (chevron_right, expand_more) are always useless as ARIA labels
  if (isIconGlyphText(finalName)) {
    return null;
  }

  // Guard 2: Ambiguous action labels (edit, delete, close) are only safe as ARIA selectors
  // when they uniquely identify a single element on the page.
  if (isAmbiguousActionLabel(finalName)) {
    // Try to count how many elements share this accessible name
    try {
      const candidateRole = role || null;
      const allMatches = Array.from(document.querySelectorAll(
        candidateRole ? `[role="${candidateRole}"]` : "button, [role='button'], a, [role='link']"
      )).filter((el) => {
        const elName = (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
        return elName === finalName.toLowerCase();
      });
      // If more than 1 element matches this name, it's truly ambiguous — skip ARIA
      if (allMatches.length !== 1) {
        return null;
      }
    } catch (_) {
      // If the DOM query fails (e.g., worker context), err on the side of caution
      return null;
    }
  }


  if (role) {
    return `aria/${role}[${finalName}]`;
  }

  // Otherwise just use the name: aria/Submit
  return `aria/${finalName}`;
}

/**
 * Finds the nearest MUI overlay (Modal, Dialog, Drawer, Popover).
 * @param {HTMLElement} el
 * @returns {HTMLElement|null}
 */
function getNearestOverlay(el) {
  let current = el ? el.parentElement : null;
  let depth = 0;
  while (current && current !== document.body && depth < 30) {
    const role = (current.getAttribute("role") || "").toLowerCase();
    if (["dialog", "alertdialog", "menu", "listbox"].includes(role))
      return current;
    if (current.tagName === "DIALOG") return current;

    const cls = current.className || "";
    if (
      typeof cls === "string" &&
      (/\b(modal|popover|dropdown-menu|drawer|popup|overlay)\b/i.test(cls) ||
        /\b(MuiModal|MuiPopover|MuiDrawer|MuiDialog|MuiMenu-paper|MuiAutocomplete-popper)\b/i.test(
          cls,
        ) ||
        /\b(ant-modal|ant-popover|ant-dropdown|ant-drawer|ant-select-dropdown)\b/i.test(
          cls,
        ) ||
        /\b(modal-dialog|modal-content)\b/i.test(cls) ||
        /\b(portal|react-select__menu|slds-modal|slds-dropdown|chakra-modal|chakra-popover)\b/i.test(
          cls,
        ))
    )
      return current;

    if (
      current.hasAttribute("data-popper-placement") ||
      current.hasAttribute("data-radix-popper-content-wrapper") ||
      current.hasAttribute("data-radix-dialog-content") ||
      current.hasAttribute("data-floating-ui-portal")
    )
      return current;

    current = current.parentElement;
    depth++;
  }
  return null;
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

/**
 * Scans all attributes on an element for any stable data-* or aria-* attribute
 * that isn't in the standard list. Katalon-style catch-all.
 * @param {HTMLElement} element
 * @returns {string|null} CSS attribute selector or null
 */
function buildAnyAttributeSelector(element) {
  const ALREADY_COVERED = new Set([
    "data-testid", "data-cy", "data-test", "data-qa",
    "aria-label", "aria-labelledby", "aria-describedby", "aria-controls",
    "aria-expanded", "aria-selected", "aria-checked", "aria-hidden",
    "role", "name", "id", "class", "style", "type", "value",
    "href", "src", "alt", "title", "placeholder", "tabindex",
    "disabled", "readonly", "required", "checked", "selected",
    "for", "action", "method", "target", "rel", "media",
  ]);

  for (const attr of element.attributes) {
    const name = attr.name.toLowerCase();
    // Only look at data-* and aria-* we haven't already covered
    if (!name.startsWith("data-") && !name.startsWith("aria-")) continue;
    if (ALREADY_COVERED.has(name)) continue;

    const val = attr.value;
    if (!val || val.trim().length === 0) continue;
    if (isDynamic(val)) continue;
    if (val.length > 100) continue;

    const tag = element.tagName.toLowerCase();
    return `${tag}[${name}="${val.replace(/"/g, '\\"')}"]`;
  }
  return null;
}

/**
 * Builds a label-to-input XPath — far more stable than positional XPath.
 * e.g. //label[normalize-space(.)='Email']/following::input[@type='email'][1]
 * @param {HTMLElement} element
 * @returns {string|null}
 */
function buildLabelXPath(element) {
  if (!["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return null;

  const tag = element.tagName.toLowerCase();
  const typeAttr =
    element.getAttribute("type") && element.getAttribute("type") !== "text"
      ? `[@type='${element.getAttribute("type")}']`
      : "";

  // 1. label[for=id]
  if (element.id && !isDynamic(element.id)) {
    const label = document.querySelector(
      `label[for="${CSS.escape(element.id)}"]`,
    );
    if (label) {
      const labelText = (label.innerText || "").replace(/\s+/g, " ").trim();
      if (labelText && labelText.length > 1 && labelText.length < 60) {
        const escaped = labelText.replace(/'/g, "\\'");
        return `xpath///label[normalize-space(.)='${escaped}']/following::${tag}${typeAttr}[1]`;
      }
    }
  }

  // 2. Wrapping label — clone and strip inputs to get clean label text
  const wrapLabel = element.closest("label");
  if (wrapLabel) {
    const clone = wrapLabel.cloneNode(true);
    clone
      .querySelectorAll("input, textarea, select")
      .forEach((i) => i.remove());
    const labelText = (clone.innerText || "").replace(/\s+/g, " ").trim();
    if (labelText && labelText.length > 1 && labelText.length < 60) {
      const escaped = labelText.replace(/'/g, "\\'");
      return `xpath///label[normalize-space(.)='${escaped}']/${tag}`;
    }
  }

  // 3. Nearest form-group/row label sibling (common in Bootstrap / Material forms)
  const container = element.closest(
    ".form-group, .form-row, .slds-form-element, .MuiFormControl-root, .field",
  );
  if (container) {
    const label = container.querySelector(
      "label, .control-label, .slds-form-element__label, .MuiFormLabel-root",
    );
    if (label && label !== element) {
      const labelText = (label.innerText || "").replace(/\s+/g, " ").trim();
      if (labelText && labelText.length > 1 && labelText.length < 60) {
        const escaped = labelText.replace(/'/g, "\\'");
        return `xpath///label[normalize-space(.)='${escaped}']/following::${tag}${typeAttr}[1]`;
      }
    }
  }

  return null;
}

/**
 * Builds a relative XPath anchored to the nearest stable ancestor.
 * Supports 3 strategies: stable ID, data-testid, and text-content context anchor.
 * @param {HTMLElement} element
 * @returns {string|null}
 */
function buildRelativeXPathFromAncestor(element) {
  const STABLE_ATTRS = ["data-testid", "data-cy", "data-test", "data-qa"];

  let anchor = element.parentElement;
  let depth = 0;
  let textAnchorResult = null;

  while (anchor && anchor !== document.body && depth < 12) {
    let anchorSelector = null;

    // Strategy 1: Stable ID anchor
    if (anchor.id && !isDynamic(anchor.id)) {
      anchorSelector = `//*[@id="${anchor.id}"]`;
    }

    // Strategy 2: Stable testid anchor
    if (!anchorSelector) {
      for (const attr of STABLE_ATTRS) {
        if (anchor.hasAttribute(attr)) {
          const val = anchor.getAttribute(attr);
          if (val && !isDynamic(val)) {
            anchorSelector = `//*[@${attr}="${val.replace(/"/g, '\\"')}"]`;
            break;
          }
        }
      }
    }

    if (anchorSelector) {
      const relPath = getXPathFromTo(element, anchor);
      if (relPath) {
        return `xpath//${anchorSelector}${relPath}`;
      }
    }

    // Strategy 3: Text-content anchor (for icon-only buttons like chevrons in rows)
    // Only compute once — at the shallowest viable row-like container
    if (!textAnchorResult) {
      const tag = anchor.tagName.toLowerCase();
      const isRowLike = ["tr", "li", "div", "section", "article"].includes(tag);
      if (isRowLike) {
        const candidateTextEls = Array.from(anchor.querySelectorAll(
          "td, th, span, p, h1, h2, h3, h4, h5, label, .title, .name"
        )).filter((el) => {
          if (el === element || el.contains(element) || element.contains(el)) return false;
          const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          return t.length > 2 && t.length < 60 && !isIconGlyphText(t);
        });

        if (candidateTextEls.length > 0) {
          const rowText = (candidateTextEls[0].innerText || candidateTextEls[0].textContent || "")
            .replace(/\s+/g, " ").trim();
          const escapedText = rowText.replace(/'/g, "\\'");

          // Only use if text is reasonably unique (appears in ≤3 matching containers)
          const matchingRows = document.querySelectorAll(tag);
          let matchCount = 0;
          for (const row of matchingRows) {
            if ((row.textContent || "").includes(rowText)) matchCount++;
            if (matchCount > 3) break;
          }

          if (matchCount <= 3) {
            const relPath = getXPathFromTo(element, anchor);
            if (relPath) {
              textAnchorResult = `xpath//${tag}[contains(., '${escapedText}')]${relPath}`;
            }
          }
        }
      }
    }

    anchor = anchor.parentElement;
    depth++;
  }

  return textAnchorResult || null;
}

/**
 * Computes the XPath segment from a descendant element up to (not including) ancestor.
 * Returns something like //input[@name="email"] or /div[2]/input[1]
 * @param {HTMLElement} element
 * @param {HTMLElement} ancestor
 * @returns {string}
 */
function getXPathFromTo(element, ancestor) {
  // If element has a unique stable attribute, use a direct descendant selector
  if (element.getAttribute("name") && !isDynamic(element.getAttribute("name"))) {
    const name = element.getAttribute("name").replace(/"/g, '\\"');
    return `//${element.tagName.toLowerCase()}[@name="${name}"]`;
  }
  if (element.id && !isDynamic(element.id)) {
    return `//${element.tagName.toLowerCase()}[@id="${element.id}"]`;
  }
  const type = element.getAttribute("type");
  const val = element.getAttribute("value");
  if (type && val && !isDynamic(val)) {
    return `//${element.tagName.toLowerCase()}[@type="${type}"][@value="${val.replace(/"/g, '\\"')}"]`;
  }

  // Fall back to positional path from ancestor
  let path = "";
  let current = element;
  while (current && current !== ancestor) {
    const tag = current.tagName.toLowerCase();
    const siblings = Array.from(current.parentElement?.children || []).filter(
      (c) => c.tagName === current.tagName,
    );
    const idx = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : "";
    path = `/${tag}${idx}` + path;
    current = current.parentElement;
  }
  return path;
}

/* ---------------- helpers ---------------- */

function isDynamic(value) {
  if (typeof value !== "string") return true;
  // Ignore purely numeric long strings or hex-like strings
  if (/^[0-9a-f]{16,}$/.test(value)) return true;

  // React / MUI / Radix / AntD dynamic IDs
  if (/^:(r[0-9a-z]*):/i.test(value)) return true;
  if (/mui-[0-9]+/.test(value)) return true;
  if (/^radix-[a-zA-Z0-9]+/.test(value)) return true;
  if (/^rc(_|-)select(_|-)[a-zA-Z0-9]+/.test(value)) return true;
  if (/^rc(_|-)tabs(_|-)[a-zA-Z0-9]+/.test(value)) return true;
  if (/^rc(_|-)menu(_|-)[a-zA-Z0-9]+/.test(value)) return true;

  // Dynamic Popper/Portal IDs with random suffix
  if (/(popper|modal|dialog|select|menu)-[a-zA-Z0-9]{8,}/i.test(value)) {
    const parts = value.split("-");
    const suffix = parts[parts.length - 1];
    if (/[A-Z]/.test(suffix) && /[a-z]/.test(suffix)) return true;
    if (/[0-9]/.test(suffix) && /[a-zA-Z]/.test(suffix)) return true;
  }

  // Allow common stable prefixes (form field IDs, component IDs, etc.)
  if (/^(mui|btn|nav|list|item|cell|otp|tfid)-/i.test(value)) return false;
  return /\d{5,}|uuid|random/i.test(value);
}

/**
 * Returns true for Material icon GLYPH names only (the raw font text content,
 * e.g. "chevron_right", "expand_more"). These are NEVER useful as locators.
 */
function isIconGlyphText(text) {
  if (!text || typeof text !== "string") return false;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const glyphs = new Set([
    "chevron_right", "chevron_left", "expand_more", "expand_less",
    "file_download", "file_upload", "west", "east", "north", "south",
    "more_vert", "more_horiz", "filter_list", "keyboard_arrow_down",
    "keyboard_arrow_up", "keyboard_arrow_left", "keyboard_arrow_right",
    "arrow_back", "arrow_forward", "arrow_drop_down", "arrow_drop_up",
    "unfold_more", "unfold_less", "drag_handle", "drag_indicator",
  ]);
  const parts = normalized.split(" ").filter(Boolean);
  return parts.length > 0 && parts.every((p) => glyphs.has(p));
}

/**
 * Returns true for generic action words that are AMBIGUOUS — i.e. multiple
 * buttons on the same page likely share this label (edit, delete, close, etc.).
 * These are only unsafe as locators when NOT unique on the page.
 */
function isAmbiguousActionLabel(text) {
  if (!text || typeof text !== "string") return false;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const ambiguous = new Set([
    "edit", "delete", "remove", "close", "add", "save", "cancel",
    "refresh", "download", "upload", "search", "menu", "more",
    "open", "view", "select", "clear",
  ]);
  return ambiguous.has(normalized);
}

/**
 * Legacy alias — kept for XPath text-match guards in generateSelectors.
 * Only blocks pure icon glyph strings from being used as XPath text matchers.
 */
function isGenericIconText(text) {
  return isIconGlyphText(text) || isAmbiguousActionLabel(text);
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

# Locator Builders Reference

This file explains how [locator-builders.js](/home/namansharma/Desktop/PROJECTS/extension/extension-src/locator-builders.js) works in plain language.

Use it when you want to understand:

- how the extension builds selectors for recorded elements
- how it chooses the best selector
- how ARIA, CSS, XPath, and modal-aware selectors work
- how selector stability and uniqueness are checked
- where to debug bad locator generation

## What `locator-builders.js` is

`locator-builders.js` is the selector engine for the extension.

Its job is to answer this question:

"If the user clicked this element now, how do we find the same element again later?"

This matters for both:

- recording
- playback

Because replay only works if the extension can find the same element again in a reliable way.

## Big picture strategy

The file does not trust only one selector format.

Instead, it tries multiple strategies:

- test attributes such as `data-testid`
- ARIA selectors
- stable IDs
- `name`, `placeholder`, `alt`, `title`, `href`, `src`
- stable classes
- CSS fallback paths
- XPath fallback paths

Then it:

1. normalizes the target element
2. collects possible selectors
3. checks whether they are unique
4. ranks them
5. picks the best one

## Main selector generation flow

### `generateSelectors(element)`

This is the main selector-building function.

It:

1. normalizes the element
2. gathers stable selector candidates
3. adds ARIA, text-based, attribute-based, CSS, and XPath selectors
4. chooses a primary selector
5. returns a rich selector object with metadata

The returned object includes:

- `selectors`: array of selector candidates
- `selector`: the chosen primary selector
- `selectorType`: the type of the primary selector
- `css`: generated CSS selector
- `xpath`: generated XPath selector
- `id`: stable ID if available
- `attributes`: important HTML attributes
- `innerText`: cleaned visible text

### `generateStableSelector(element)`

This is a smaller helper that returns just one best stable selector instead of the full selector bundle.

## Element normalization

### `normalizeSelectorTarget(element)`

Purpose:

- fix the target before generating selectors

Why this is needed:

- users often click nested child nodes such as `svg`, `path`, `span`, or icon elements
- those child nodes are often bad replay targets

What the function does:

- returns the nearest menu/list option parent if the element is inside one
- if the target is a nested icon-like or decorative child, it tries to return the nearest actionable parent such as a button or link
- otherwise it returns the element unchanged

This makes selectors more reliable because the extension targets the real interactive element instead of a tiny child node.

## XPath helpers

### `getXPath(element)`

Purpose:

- generate an XPath for an element

How it works:

- if a stable element ID exists, prefer `//*[@id="..."]`
- otherwise walk up the DOM and build an indexed XPath path

### `getFullXPath(element)`

Purpose:

- generate a full absolute XPath from the root, ignoring IDs

Why it exists:

- this is a last-resort style XPath when cleaner selectors are not available

### `buildXPath(el)`

Purpose:

- manually builds a full XPath by walking upward through parents and counting sibling positions

This is another low-level XPath helper used by the system.

### `getElementsByXPath(xpath)`

Purpose:

- execute an XPath against the page
- return matching elements as a normal array

Why it exists:

- XPath uniqueness checks need an actual way to run XPath queries

## Stable selector candidate collection

### `collectStableSelectorCandidates(element)`

Purpose:

- build a ranked list of selector candidates that look stable enough to reuse later

The function considers:

- test attributes:
  - `data-testid`
  - `data-test`
  - `data-cy`
- `aria-label`
- stable IDs
- `name`
- ARIA text-based selectors
- `role`
- stable class names
- fallback CSS paths

Each candidate is stored with:

- `priority`
- `value`

Lower priority numbers are better.

Example idea:

- priority 1 may be `data-testid`
- priority 10 may be a fallback CSS path

### Modal scoping

This function also checks whether the element is inside a modal, drawer, dialog, or overlay.

If yes, it may prefix selectors with a modal scope selector so replay does not accidentally match background elements outside the modal.

## Picking the best selector

### `pickBestStableSelector(element, candidates)`

Purpose:

- choose the best selector from the candidate list

How it works:

1. keep only candidates that are unique for the target element, or fallback CSS candidates
2. sort by priority first
3. if priorities are equal, prefer the shorter selector
4. return the best one

If no strong selector exists, the function falls back to a generated CSS path.

## Text-based selector helpers

### `buildActionableTextSelector(element)`

Purpose:

- create an ARIA-style selector for interactive elements like buttons and links

Examples:

- `aria/button[Save]`
- `aria/link[Open Details]`

The function only does this when:

- the element is actionable
- the visible text is not empty
- the text is not too long
- the text is not generic icon text

### Overlay-aware ARIA chaining

If the element is inside an overlay and the overlay has a meaningful name and role, the function may return a chained selector like:

```text
aria/dialog[Edit User] >> aria/button[Save]
```

This makes the selector much safer when duplicate buttons exist elsewhere on the page.

### `buildContextualButtonXPath(element)`

Purpose:

- create a context-aware XPath for repeated buttons like `Edit` or `Delete`

Why it exists:

- pages often have many `Edit` or `Delete` buttons
- text alone is not unique enough

What it does:

- only works for buttons whose descriptor is `Edit` or `Delete`
- walks up the DOM to find surrounding context text
- builds an XPath that combines the button identity with nearby row/card text

This helps target the correct repeated button in lists, tables, or cards.

## ARIA support

### `buildAriaSelector(element)`

Purpose:

- build an ARIA selector from the element’s accessible identity

It uses:

- `getElementDescriptor(element)` for the accessible name
- `getAriaRole(element)` for the role
- `getNearestOverlay(element)` for overlay context

Possible outputs:

- `aria/Submit`
- `aria/button[Save]`
- `aria/dialog[Edit User] >> aria/button[Save]`

### `getAriaRole(element)`

Purpose:

- determine the element’s effective ARIA role

How it works:

- explicit `role` attribute wins first
- some library-specific option elements are treated as `option`
- otherwise implicit HTML semantics are used

Examples:

- `BUTTON` becomes `button`
- `A` becomes `link`
- `INPUT type="checkbox"` becomes `checkbox`
- `INPUT type="number"` becomes `spinbutton`

### `queryAriaSelector(selector)`

Purpose:

- manually search the DOM using the custom `aria/...` selector format

Why it exists:

- browsers do not support your custom ARIA selector format directly in `querySelectorAll(...)`

How it works:

- split chained selectors by ` >> `
- search matching nodes part by part
- compare accessible name using:
  - `aria-label`
  - `getElementDescriptor(...)`
  - visible text
- optionally match ARIA role

### `getAriaCandidatePool(context)`

Purpose:

- return the set of nodes that should be searched for ARIA matches

If context is:

- `document`, return all elements in the page
- a specific element, return that element plus all descendants

## Modal and overlay support

### `getNearestOverlay(el)`

Purpose:

- find the nearest overlay-like ancestor

It looks for:

- ARIA roles like `dialog`, `alertdialog`, `menu`, `listbox`
- `<dialog>` elements
- known overlay class names from common UI libraries
- overlay-related attributes from libraries like Radix or Floating UI

### `getModalScopeSelector(container)`

Purpose:

- build a selector for the modal/dialog container itself

Priority order:

- test attributes
- `aria-label`
- stable ID
- known framework classes
- `[role="dialog"]`

This scope selector is used to make child selectors safer.

## CSS helpers

### `escapeSelectorValue(value)`

Purpose:

- escape backslashes and quotes inside selector values

Why this matters:

- selectors would break if attribute values contain special characters

### `getStableClasses(element)`

Purpose:

- return only stable class names that are safe enough to use in selectors

The function removes:

- dynamic/generated class names
- temporary state classes such as:
  - `active`
  - `open`
  - `disabled`
  - `Mui-selected`

Then it sorts the remaining classes by length.

### `buildCssSegment(element)`

Purpose:

- build one CSS path segment for a single element

Priority order:

1. test attribute, `name`, or `aria-label`
2. stable ID
3. stable class
4. role
5. plain tag name

### `buildFallbackCssPath(element, scopeRoot)`

Purpose:

- build a longer CSS path by walking upward through parents until the selector becomes unique

How it works:

- normalize the target first
- build path segments from the element upward
- prepend modal scope if needed
- stop as soon as a unique selector is found

This makes fallback selectors shorter than a full absolute path whenever possible.

### `buildCssPath(el)`

Purpose:

- shorthand wrapper for `buildFallbackCssPath(el)`

### `buildSelector(element)`

Purpose:

- return the first non-ARIA stable CSS candidate
- if none exists, use the fallback CSS path

## Selector validation

### `isSelectorUnique(selector, element)`

Purpose:

- check whether a selector matches exactly one element
- confirm that the match is the exact target element

Supported selector types:

- ARIA selectors
- XPath selectors
- normal CSS selectors

Why this is critical:

- a selector is only useful if it finds the correct element and only that element

## Selector type classification

### `getSelectorType(selector)`

Purpose:

- classify a selector string into a simple label

Possible return values include:

- `aria`
- `xpath`
- `id`
- `testId`
- `name`
- `placeholder`
- `alt`
- `title`
- `href`
- `src`
- `nth`
- `css`

This helps with debugging, reporting, and later selector handling.

## Stability helpers

### `isDynamic(value)`

Purpose:

- detect values that look autogenerated, random, or unstable

It rejects values such as:

- long hex strings
- React/Radix/MUI-generated patterns
- CSS-in-JS hashes
- strings containing `uuid`, `token`, `nonce`, `generated`, and similar words
- very long numeric sequences

### `isDynamicId(id)`

Purpose:

- alias of `isDynamic(...)` for IDs

### `isDynamicClass(cls)`

Purpose:

- alias of `isDynamic(...)` for classes

### `isGenericIconText(text)`

Purpose:

- detect text that is too generic to use as a meaningful selector

Examples:

- `close`
- `edit`
- `delete`
- `menu`
- `refresh`

Why this matters:

- these words often appear many times and are weak selectors on their own

### `isStableUrl(url)`

Purpose:

- reject URLs that are likely dynamic or session-specific

It rejects URLs that are:

- too long
- `data:`, `blob:`, or `javascript:` URLs
- token/session-based
- full of long random hex values
- dynamic hash anchors

This is used when deciding whether `href` or `src` is safe enough to use as part of a selector.

## Current placeholder helper

### `buildNthSelector(element)`

Purpose:

- intended to build selectors like `button:nth-of-type(2)`

Current state:

- not implemented
- currently returns `null`

## Common debugging questions

When locator generation looks wrong, check:

- Did `normalizeSelectorTarget(...)` choose the right element?
- Is the element inside a modal or overlay that should be used as scope?
- Did a dynamic ID or class get incorrectly accepted?
- Is the visible text too generic?
- Did `isSelectorUnique(...)` reject a selector because it matched multiple elements?
- Is an ARIA selector failing because the accessible name is wrong?
- Did `buildFallbackCssPath(...)` stop too early or too late?
- Is `getElementDescriptor(...)` returning the descriptor you expect?

## Fast mental model

If you want one short summary to remember:

- `locator-builders.js` is the selector brain of the extension
- it tries many ways to identify the same element again later
- it prefers stable, unique, human-meaningful selectors
- it uses modal context and accessibility context when needed
- it falls back to longer CSS or XPath paths only when cleaner selectors are not enough

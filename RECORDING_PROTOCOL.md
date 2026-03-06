# 🎬 Recording Protocol

Best practices for recording reliable E2E test flows with the extension.

---

## ✅ DO

### Before Recording

- **Close all unnecessary tabs** — the extension injects into every tab
- **Start from a clean state** — navigate to the starting page before hitting Record
- **Make sure the app is fully loaded** — wait for spinners/loaders to finish
- **Reload the extension** from `chrome://extensions` if you updated code

### During Recording

- **Click directly on the target element** — don't click its icon or child span
- **Wait 1-2 seconds between actions** — let the app finish rendering before your next click
- **Wait for dropdowns to fully open** before clicking an option
- **Wait for modals/drawers to fully appear** before interacting with elements inside them
- **Use unique input values** — type distinctive text (e.g., "TestCompany_ABC") not generic text like "test"
- **Click labels, not invisible inputs** — for radio buttons and checkboxes, click the visible label text
- **Scroll slowly** — rapid scrolling generates many scroll steps

### For Form Fields

- **Click the field first, then type** — this ensures the click and input are recorded as separate steps
- **Let autocomplete/search finish** — wait for dropdown results to appear before selecting
- **Clear existing values before typing** — select-all (Ctrl+A) and delete before typing new values

### For Dropdowns (React-Select, MUI)

- **Click the dropdown to open it**
- **Wait for options to load** (if async)
- **Then click the desired option**
- **Don't type too fast** — let the search filter update between keystrokes

---

## ❌ DON'T

### Actions to Avoid

- **Don't double-click** unless the app requires it — it records 2 click steps
- **Don't right-click** during recording — it triggers context menu selectors
- **Don't hover for tooltips** — hover actions are not recorded
- **Don't use keyboard shortcuts** (Ctrl+C, Tab, Enter) — only clicks and typing are captured
- **Don't click outside a modal to close it** — click the X/Close button instead
- **Don't interact with the extension panel** while recording (it has `data-recorder-ui` protection, but still)

### Form Pitfalls

- **Don't type into a field that already has text** without clearing it first
- **Don't click the same field multiple times** — it generates redundant click steps
- **Don't select text with mouse** — drag selections aren't captured
- **Don't paste from clipboard** — Ctrl+V isn't tracked as an input event

### Navigation Pitfalls

- **Don't use browser Back/Forward buttons** — use in-app navigation
- **Don't manually edit the URL bar** — navigate through the app's UI
- **Don't switch between tabs** during recording
- **Don't let the page auto-refresh** (e.g., from hot-reload) during recording

---

## 🎯 Selector Priority (What Makes a Good Recording)

The recorder generates selectors in this priority order. Steps with higher-priority selectors are more reliable:

| Priority | Selector         | Reliability | Example                         |
| -------- | ---------------- | ----------- | ------------------------------- |
| 1        | `data-testid`    | ⭐⭐⭐⭐⭐  | `[data-testid="submit-btn"]`    |
| 2        | Stable ID        | ⭐⭐⭐⭐⭐  | `#username`                     |
| 3        | Name attribute   | ⭐⭐⭐⭐    | `input[name="email"]`           |
| 4        | Placeholder      | ⭐⭐⭐⭐    | `[placeholder="Search..."]`     |
| 5        | ARIA (role+name) | ⭐⭐⭐      | `aria/button[Submit]`           |
| 6        | XPath text       | ⭐⭐⭐      | `xpath///button[text()='Save']` |
| 7-12     | CSS/fallbacks    | ⭐⭐        | Position-based selectors        |

**Tip:** Elements with `data-testid`, `id`, `name`, or `placeholder` attributes produce the most stable recordings. Ask your dev team to add `data-testid` to key interactive elements.

---

## 🔄 After Recording

1. **Review the steps** in the extension panel — delete any accidental clicks
2. **Save the flow** with a descriptive name (e.g., `Create_Material_PO`)
3. **Play it back once** immediately to verify it works
4. **If playback fails**, check which step failed and re-record that section
5. **Export as backup** — use the JSON export feature

---

## ⚠️ Common Failure Patterns

| Symptom                       | Cause                                  | Fix                                           |
| ----------------------------- | -------------------------------------- | --------------------------------------------- |
| Clicks wrong element          | ARIA label matches multiple elements   | Re-record; click more specific element        |
| Input goes to wrong field     | Placeholder changed (React-Select)     | Re-record; the fix skips short placeholders   |
| Step stalls on "not visible"  | Modal didn't open in time              | Add manual wait or re-record with slower pace |
| Steps executed in wrong order | Rapid clicking during recording        | Slow down — wait 1-2s between actions         |
| "Element not found"           | Page structure changed since recording | Re-record the affected steps                  |

# Content Script Reference

This file explains how [content.js](/home/namansharma/Desktop/PROJECTS/extension/extension-src/content.js) works in plain language.

Use it when you want to understand:

- what the content script does inside a webpage
- how page-side recording state works
- how the background script talks to the page
- how playback commands are routed
- where to debug content-script problems

## What `content.js` is

`content.js` is the entry point for the extension code that runs inside the actual webpage.

It does not replace `recorder.js` or `playback.js`. Instead, it acts like a bridge and coordinator for page-side behavior.

Think of the three main extension worlds like this:

- `popup.js` is the control panel
- `background.js` is the coordinator
- `content.js` is the page-side bridge

## Main responsibilities of `content.js`

`content.js` is responsible for:

- keeping page-side recording state in sync with background state
- preventing duplicate initialization
- tracking the last right-clicked element
- exposing a toggle function that background can call
- listening for commands from background
- routing step execution to playback functions
- returning page-specific data such as ARIA snapshots

## Shared global state on `window`

### `window.isRecording`

```js
if (typeof window.isRecording === "undefined") {
  window.isRecording = false;
}
```

Purpose:

- stores whether recording is currently active inside this page context

Why it lives on `window`:

- multiple injected scripts can read and write the same global value
- this makes page-side state shared across modular scripts

## Duplicate initialization guard

### `window.__recorder_initialized`

```js
if (!window.__recorder_initialized) {
  window.__recorder_initialized = true;
  ...
}
```

Purpose:

- makes sure setup only happens once

Why it matters:

- content scripts can be injected more than once
- without this guard, listeners could be added multiple times
- duplicate listeners can cause duplicated events, duplicate messages, or confusing bugs

## Tracking the last right-clicked element

### `window.lastRightClickedElement`

```js
window.lastRightClickedElement = null;
```

Purpose:

- stores the most recent element the user right-clicked on

This is used later for commands that need information about the right-click target, such as assertion-related actions.

### `contextmenu` listener

```js
window.addEventListener(
  "contextmenu",
  (event) => {
    const composedPath = event.composedPath();
    window.lastRightClickedElement =
      composedPath.length > 0 ? composedPath[0] : event.target;
  },
  true,
);
```

Purpose:

- listens for right-click events
- stores the most accurate clicked element

Why `event.composedPath()` is used:

- it helps capture the real underlying element, including in complex DOM situations like Shadow DOM

Why capture phase is used:

- the final `true` means the listener runs in capture phase
- this makes it more likely the extension sees the event before page code interferes

## Exposing a toggle function for background

### `window.__recorder_toggle = function (state) { ... }`

This creates a function on `window` that background can call indirectly using injected page code.

What it does:

- sets `window.isRecording`
- updates the visual indicator if available
- logs the current page URL and new state

### Visual indicator update

```js
if (typeof updateVisualIndicator === "function") {
  updateVisualIndicator(state);
}
```

Purpose:

- updates page UI so recording status is visible

Where the function comes from:

- `updateVisualIndicator(...)` is defined in `utils.js`

Why there is a type check:

- the code avoids crashing if the helper is not loaded for some reason

## State synchronization on startup

### Asking background for current state

```js
chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
  if (response) {
    window.__recorder_toggle(response.isRecording);
  }
});
```

Purpose:

- when `content.js` starts, it asks background whether recording is already on

Why this is needed:

- the page-side script does not automatically know background state
- after reloads or reinjection, the page needs to resync with background

What happens:

1. content script sends `GET_STATE`
2. background replies with extension state
3. content script updates `window.isRecording`
4. visual indicator is updated to match

## Incoming message listener

### `chrome.runtime.onMessage.addListener(...)`

This listener receives commands from background.

It supports these message types:

- `SET_RECORDING`
- `EXECUTE_SINGLE_STEP`
- `GET_LAST_RIGHT_CLICKED`
- `GET_ARIA_SNAPSHOT`

The listener returns `true` so async responses continue to work.

## Message type: `SET_RECORDING`

```js
if (message.type === "SET_RECORDING") {
  window.__recorder_toggle(message.isRecording);
  sendResponse({ success: true, isRecording: window.isRecording });
}
```

Purpose:

- background tells the page to turn recording on or off

What happens:

- `window.isRecording` is updated
- visual indicator is updated
- a response confirms the new state

When this is used:

- start recording
- stop recording
- restore recording state after page reload

## Message type: `EXECUTE_SINGLE_STEP`

```js
} else if (message.type === "EXECUTE_SINGLE_STEP") {
```

Purpose:

- background wants the page to execute one playback step

This is one of the most important responsibilities of `content.js`.

### Routing to playback logic

If `executeSingleStep(...)` exists, `content.js` forwards the work there.

Where it comes from:

- `executeSingleStep(...)` is defined in `playback.js`

### Special case for assertions

```js
if (message.step.action.startsWith("assert")) {
```

Purpose:

- assertion steps are handled differently from normal steps

Examples:

- `assertText`
- `assertExists`

### Assertion success/failure reporting

If the assertion succeeds:

```js
chrome.runtime.sendMessage({
  type: "STEP_COMPLETE",
  stepIndex: message.stepIndex,
})
```

If the assertion fails:

```js
chrome.runtime.sendMessage({
  type: "STEP_ERROR",
  error: err.message,
  stepIndex: message.stepIndex,
})
```

Why this matters:

- background controls the full run
- content script only performs page-side work and reports the outcome

### Non-assert steps

For non-assert actions, this file calls:

```js
executeSingleStep(message.step, message.stepIndex, message.nextStep);
```

Meaning:

- actual playback logic lives in `playback.js`
- `content.js` acts as the router

### Important distinction

The line:

```js
sendResponse({ success: true, message: "Step execution started" });
```

does not mean the step finished successfully.

It only means:

- the request was received
- page-side execution was started

The real completion result is sent later with:

- `STEP_COMPLETE`
- `STEP_ERROR`

## Message type: `GET_LAST_RIGHT_CLICKED`

Purpose:

- return information about the most recently right-clicked element

What happens:

- the code checks whether a stored right-click target exists
- it generates selectors for that element
- it generates a readable description
- it returns a step-like object

### Helper functions used

- `generateSelectors(...)` from `locator-builders.js`
- `getElementDescriptor(...)` from `utils.js`

### Returned data

The returned object may include:

- selector bundle
- primary selector
- selector type
- tag name
- element description
- current page URL

Why this is useful:

- right-click actions can later become assertions or recorded actions

## Message type: `GET_ARIA_SNAPSHOT`

Purpose:

- return a structured accessibility snapshot of the current page

How it works:

- if `captureAriaSnapshotContent(...)` exists, call it
- return the snapshot on success
- return an error if snapshot capture fails

Why this is used:

- `background.js` can request a snapshot at the end of playback
- the backend can store that snapshot for debugging or reporting

## Final initialization logs

### Detect frame type

```js
const frameType = window === window.top ? "TOP FRAME" : "SUBFRAME";
```

Purpose:

- determine whether this content script is running in the main page or inside an iframe

Why it matters:

- your extension injects scripts into `allFrames`
- one tab may contain multiple page contexts

### Debug logs

The file logs both to console and to the background logger:

- where the content script was initialized
- whether it was in top frame or subframe
- that the modular entry point is ready

Why this is helpful:

- content-script injection issues are common in Chrome extensions
- these logs help confirm where the script actually loaded

## Communication model

The simplest mental model is:

- background decides what should happen
- content script performs page-local work
- recorder and playback modules do the detailed DOM work

## Common execution flows

### Startup flow

1. `content.js` loads into the page
2. it checks `window.__recorder_initialized`
3. it sets up page globals
4. it asks background for current state with `GET_STATE`
5. it updates page recording state if needed
6. it registers message listeners

### Recording toggle flow

1. background sends `SET_RECORDING`
2. content script calls `window.__recorder_toggle(...)`
3. `window.isRecording` changes
4. `updateVisualIndicator(...)` updates the page UI

### Playback flow

1. background sends `EXECUTE_SINGLE_STEP`
2. content script receives it
3. if action is assert-related, use assertion logic
4. otherwise call `executeSingleStep(...)`
5. content script later reports back:
   - `STEP_COMPLETE`
   - or `STEP_ERROR`

### Snapshot flow

1. background sends `GET_ARIA_SNAPSHOT`
2. content script captures page snapshot
3. content script returns snapshot data
4. background uploads it to backend

## Common debugging questions

When `content.js` seems broken, check:

- Did the script initialize more than once?
- Did `GET_STATE` return the expected recording state?
- Did `SET_RECORDING` actually change `window.isRecording`?
- Did `executeSingleStep(...)` exist when playback started?
- Did the page send `STEP_COMPLETE` or `STEP_ERROR` back?
- Was `lastRightClickedElement` actually captured?
- Is the content script running in the top frame or an iframe?
- Did the required helper functions load:
  - `updateVisualIndicator`
  - `generateSelectors`
  - `getElementDescriptor`
  - `captureAriaSnapshotContent`
  - `executeSingleStep`

## Fast mental model

If you want one short summary to remember:

- `content.js` is the page-side bridge
- it syncs recording state with background
- it routes background commands to recorder/playback helpers
- it exposes page information back to background

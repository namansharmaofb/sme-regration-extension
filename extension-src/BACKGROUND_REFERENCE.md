# Background Script Reference

This file explains how [background.js](/home/namansharma/Desktop/PROJECTS/extension/extension-src/background.js) works in plain language.

Use it when you want to understand:

- how recording starts and stops
- how playback starts and advances
- how messages move between popup, background, and content scripts
- where to debug when execution gets stuck

## What `background.js` is

`background.js` is the coordinator for the extension.

It acts like the control center that:

- stores recording state
- stores the current recorded test case
- starts and manages playback
- saves execution state in Chrome storage
- receives messages from popup and content scripts
- sends logs and final execution reports

This file runs as a Chrome extension service worker, which means Chrome can pause or restart it. That is why the file saves important state to `chrome.storage.local`.

## Main state variables

### Recording state

```js
let isRecording = false;
let currentTestCase = { name: "Untitled Test", steps: [] };
let lastExecutionStatus = null;
const API_BASE_URL = "http://localhost:4000";
```

- `isRecording`: whether recording is currently on
- `currentTestCase`: the test being built while the user records actions
- `lastExecutionStatus`: summary of the most recent playback run
- `API_BASE_URL`: backend server used for reports and snapshots

### Execution state

```js
let executionState = {
  isRunning: false,
  tabId: null,
  steps: [],
  currentIndex: 0,
  waitingForNavigation: false,
  stepResults: [],
  testId: null,
  startTime: null,
};
```

- `isRunning`: whether playback is currently active
- `tabId`: the browser tab being controlled
- `steps`: the list of steps to replay
- `currentIndex`: which step is currently being executed
- `waitingForNavigation`: whether the extension is waiting for a page load
- `stepResults`: success/failure result for each step
- `testId`: backend test ID
- `startTime`: when playback started

## Why state is saved

`background.js` saves execution state to `chrome.storage.local` with `saveExecutionState()` and restores it with `loadExecutionState()`.

This exists because Chrome service workers are not guaranteed to stay alive forever. If the worker is restarted, the extension can reload execution state and continue.

## Core helper functions

### `backgroundLog(text, level = "info")`

Purpose:

- logs to the console
- sends log messages to other extension parts such as the popup

Why it exists:

- so logging is consistent everywhere

### `recordStepResult(stepIndex, status, message = null)`

Purpose:

- stores whether a step passed or failed
- prevents duplicate results for the same step
- saves updated execution state

Why it exists:

- playback can fail, timeout, or succeed asynchronously
- the extension needs a stable record of what happened

### `postExecutionReport(status, error, ariaSnapshotUrl)`

Purpose:

- sends the final run report to the backend

What it includes:

- overall status
- duration
- error message
- ARIA snapshot URL
- step results

## Playback flow

### `executeCurrentStep()`

This is the heart of playback.

Its job is to:

1. stop immediately if playback is not active
2. finish the run if all steps are done
3. set a timeout for the current step
4. recover the correct tab if needed
5. navigate if the browser is on the wrong page
6. inject content scripts if needed
7. send `EXECUTE_SINGLE_STEP` to the page

### Step timeout logic

Each step gets a timeout using `setTimeout(...)`.

Why:

- if the content script never sends `STEP_COMPLETE`, the background script should not wait forever

Special behavior:

- scroll steps are treated as best-effort and may auto-continue
- other steps usually fail the run on timeout

### Tab recovery logic

If `chrome.tabs.get(executionState.tabId)` fails, the code tries to find a replacement tab by URL.

Current limitation:

- the fallback currently looks for `localhost:3007` or `localhost:3000`
- this means the recovery logic is currently biased toward your local app and is not fully generic

### URL matching logic

The helper functions:

- `normalizeUrl(url)`
- `urlsHaveSamePath(url1, url2)`

exist to avoid unnecessary navigations.

Important detail:

- for interaction steps like `click`, `input`, `scroll`, and `upload`, the code can compare only the path
- this helps avoid false mismatches in SPAs where query params change often

## Finishing playback

### `finishExecution(success, error = null)`

This function runs when playback ends.

It does these things:

1. logs that execution has ended
2. stops navigation waiting
3. tries to capture an ARIA snapshot from the page
4. uploads the snapshot to the backend
5. posts the final execution report
6. marks execution as no longer running
7. saves final state
8. sends `EXECUTION_STATUS_UPDATE`

Important design choice:

- `executionState.isRunning` is kept `true` until reporting is done
- this reduces the chance of losing final status if the worker is suspended too early

## Tab update handling

### `chrome.tabs.onUpdated.addListener(...)`

This listener handles page reloads and navigation completion.

It has two main jobs.

### 1. Keep recording alive after reload

If recording is active and the tab finishes loading, the background script sends:

```js
{ type: "SET_RECORDING", isRecording: true }
```

Why:

- page reloads reset page-side state
- the content script needs to be told that recording is still on

### 2. Resume playback after navigation

If playback is running and the controlled tab finishes loading:

- if `waitingForNavigation` is `true`, the extension resumes execution after a short delay
- if `waitingForNavigation` is `false` but the current step is a `click`, the code may assume the click succeeded if a page load happened

This second case is a heuristic to handle the situation where the page reloads before the content script can send `STEP_COMPLETE`.

## Message handling

### `chrome.runtime.onMessage.addListener(...)`

This listener receives messages from popup and content scripts.

It:

- stores a lightweight message log in `chrome.storage.local`
- forwards work to `handleMessageAsync(...)`
- returns `true` so async responses still work

### `handleMessageAsync(message, sender, sendResponse)`

This is the main message router.

Before processing messages, it may wait for `isStateLoaded` so state restoration finishes first.

## Message types and what they do

### `START_RECORDING`

What happens:

- `isRecording` becomes `true`
- `currentTestCase` is reset
- scripts are injected into the active tab
- `window.__recorder_toggle(true)` is run in all frames
- popup receives `{ success: true }`

Why:

- the background script turns recording on both in its own state and in the page context

### `STOP_RECORDING`

What happens:

- `isRecording` becomes `false`
- `window.__recorder_toggle(false)` runs in all frames
- popup receives `{ success: true, testCase: currentTestCase }`

Why:

- stopping recording also returns the final test case

### `RECORD_STEP`

What happens:

- if recording is active and a valid step exists, it is appended to `currentTestCase.steps`
- a timestamp is added

Why:

- content scripts capture user actions, but background owns the saved test case

### `GET_STATE`

What happens:

- returns:
  - `isRecording`
  - `currentTestCase`
  - `lastExecutionStatus`

Why:

- popup and content scripts may need current extension state

### `START_EXECUTION`

What happens:

- `executionState` is reset for a fresh run
- `isRunning` becomes `true`
- step list, tab ID, start time, and backend test ID are stored
- execution state is saved
- `executeCurrentStep()` begins playback

### `STEP_COMPLETE`

What happens:

- only handled if playback is still running
- current step timeout is cleared
- current step result is recorded as success
- `currentIndex` is incremented
- execution state is saved
- `executeCurrentStep()` is called again

Why timeout is cleared:

- otherwise an old timer could still fire and incorrectly fail the run

### `STEP_ERROR`

What happens:

- timeout is cleared
- failure is recorded for the current step
- `finishExecution(false, message.error)` is called

Why:

- once a step fails, the full run is treated as failed

## Communication model

A simple way to think about the system:

- popup starts and stops things
- background coordinates everything
- content scripts interact with the page

### Record flow

1. Popup sends `START_RECORDING`
2. Background turns recording on
3. Content script captures user action
4. Content script sends `RECORD_STEP`
5. Background appends the step
6. Popup sends `STOP_RECORDING`
7. Background returns the finished test case

### Playback flow

1. Popup sends `START_EXECUTION`
2. Background sets `executionState`
3. Background calls `executeCurrentStep()`
4. Background sends `EXECUTE_SINGLE_STEP` to content script
5. Content script performs the step
6. Content script sends either:
   - `STEP_COMPLETE`
   - `STEP_ERROR`
7. Background either advances or ends execution

## Common debugging questions

When playback fails or gets stuck, check these first:

- Is `executionState.isRunning` still `true`?
- Is `executionState.currentIndex` advancing?
- Was `executionState.stepTimeout` cleared?
- Did the tab navigate unexpectedly?
- Did `STEP_COMPLETE` or `STEP_ERROR` actually arrive?
- Was the content script injected into the current page?
- Is `waitingForNavigation` stuck as `true`?

When recording fails, check:

- Did `START_RECORDING` run successfully?
- Did `window.__recorder_toggle(true)` run in the page?
- Is the page allowed for script injection?
- Are `RECORD_STEP` messages arriving?

## Current app-specific behavior to remember

The extension has broad permissions in `manifest.json`, but some logic in `background.js` is still app-specific.

Examples:

- fallback tab recovery looks for localhost URLs
- URL path normalization includes prefixes like `/ovs/`, `/accordd/`, `/billing/`, and `/inventory/`

That means the extension is not fully site-agnostic yet, even though content scripts are allowed on many sites.

## Fast mental model

If you want one short summary to remember:

- `background.js` is the brain
- popup sends commands to it
- content scripts report events back to it
- it stores state, advances steps, handles navigation, and reports results

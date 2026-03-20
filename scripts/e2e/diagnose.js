/**
 * Extension Diagnostic Script
 * Tests what the extension can/cannot detect on the target site.
 * Reports ARIA coverage, selector quality, and potential gaps.
 */
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const EXTENSION_PATH = path.resolve(__dirname, "../../extension-src");
const TARGET_URL = process.env.TARGET_URL || "http://localhost:3007";
const TEST_EMAIL = process.env.E2E_TEST_EMAIL || "";
const TEST_OTP = process.env.E2E_TEST_OTP || "111111";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function log(color, label, msg) {
  console.log(`${color}[${label}]${RESET} ${msg}`);
}


async function runDiagnostic() {
  log(CYAN, "DIAG", `Starting diagnostic on ${TARGET_URL}`);
  log(CYAN, "DIAG", `Extension path: ${EXTENSION_PATH}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      defaultViewport: { width: 1440, height: 900 },
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(20000);

    // ── Step 1: Navigate to site ──
    log(CYAN, "NAV", `Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 30000 });
    const currentUrl = page.url();
    log(GREEN, "NAV", `Landed on: ${currentUrl}`);

    // ── Step 2: Handle login if redirected ──
    const isLoginPage =
      currentUrl.includes("login") ||
      currentUrl.includes("signin") ||
      currentUrl.includes("auth") ||
      (await page.$('input[type="email"], input[type="tel"], input[placeholder*="email" i], input[placeholder*="phone" i]'));

    if (isLoginPage) {
      log(YELLOW, "AUTH", `Login page detected — attempting login with ${TEST_EMAIL}`);
      await handleLogin(page);
    }

    // ── Step 3: Wait for main content ──
    await new Promise(r => setTimeout(r, 2000));
    const mainUrl = page.url();
    log(GREEN, "NAV", `Post-auth URL: ${mainUrl}`);

    // ── Step 4: Run all diagnostics ──
    const report = {};

    log(CYAN, "AUDIT", "Capturing ARIA tree...");
    try {
      report.ariaTree = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el || el.nodeType !== 1) return false;
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && el.offsetWidth > 0 && el.offsetHeight > 0;
        };
        const getAriaRole = (el) => el.getAttribute("role") || el.tagName.toLowerCase() || "generic";
        const getAriaName = (el) => {
          const label = el.getAttribute("aria-label");
          if (label) return label;
          const lby = el.getAttribute("aria-labelledby");
          if (lby) { const le = document.getElementById(lby); if (le) return le.innerText.trim(); }
          const title = el.getAttribute("title");
          if (title) return title;
          if (el.tagName === "IMG") { const alt = el.getAttribute("alt"); if (alt) return alt; }
          return (el.innerText || "").split("\n")[0].trim().substring(0, 100);
        };
        const walk = (node, depth = 0) => {
          if (!node || node.nodeType !== 1 || !isVisible(node) || depth > 15) return null;
          const tag = node.tagName;
          if (["SCRIPT","STYLE","NOSCRIPT","HEAD","META","LINK"].includes(tag)) return null;
          const snap = { role: getAriaRole(node), name: getAriaName(node) };
          if (node.children && node.children.length > 0) {
            const ch = Array.from(node.children).map(c => walk(c, depth + 1)).filter(Boolean);
            if (ch.length > 0) snap.children = ch;
          }
          return snap;
        };
        try { return walk(document.body); } catch(e) { return { error: e.message }; }
      });
    } catch (e) {
      report.ariaTree = { error: e.message };
    }

    log(CYAN, "AUDIT", "Auditing selector quality on interactive elements...");
    try {
      report.selectors = await page.evaluate(() => {
        const isDynId = (id) => !id || /^\d|[a-f0-9]{16,}|mui-[0-9]+|:(r[0-9a-z]+):|^[0-9a-f]{8}-[0-9a-f]{4}/i.test(id);
        const results = { total: 0, withTestId: 0, withAriaLabel: 0, withStableId: 0, withName: 0, onlyXPath: 0, elements: [] };
        const sel = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';
        document.querySelectorAll(sel).forEach(el => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || el.offsetWidth === 0) return;
          results.total++;
          const testAttrs = ["data-testid","data-cy","data-test","data-qa"];
          const hasTestId = testAttrs.some(a => el.hasAttribute(a));
          const hasAriaLabel = !!(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"));
          const hasStableId = el.id && !isDynId(el.id);
          const hasName = !!el.getAttribute("name");
          if (hasTestId) results.withTestId++;
          else if (hasAriaLabel) results.withAriaLabel++;
          else if (hasStableId) results.withStableId++;
          else if (hasName) results.withName++;
          else results.onlyXPath++;
          const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().substring(0, 60);
          results.elements.push({ tag: el.tagName, type: el.type || null, text, hasTestId, hasAriaLabel, hasStableId, hasName, quality: hasTestId ? "BEST" : hasAriaLabel ? "GOOD" : (hasStableId || hasName) ? "OK" : "FRAGILE" });
        });
        return results;
      });
    } catch (e) {
      report.selectors = { error: e.message };
    }

    log(CYAN, "AUDIT", "Checking for Shadow DOM...");
    try {
      report.shadowDomCount = await page.evaluate(() => {
        let n = 0;
        const walk = (el) => { if (el.shadowRoot) { n++; walk(el.shadowRoot); } for (const c of el.children || []) walk(c); };
        walk(document.body);
        return n;
      });
    } catch (e) {
      report.shadowDomCount = -1;
    }

    log(CYAN, "AUDIT", "Checking for iframes...");
    try {
      report.iframes = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("iframe")).map(f => ({ src: f.src || f.getAttribute("src") || "no-src", id: f.id || null, name: f.name || null, width: f.offsetWidth, height: f.offsetHeight }));
      });
    } catch (e) {
      report.iframes = [];
    }

    log(CYAN, "AUDIT", "Checking framework & dynamic content...");
    try {
      report.framework = await page.evaluate(() => {
        return {
          hasReact: !!(window.React || document.querySelector("[data-reactroot]") || window.__REACT_DEVTOOLS_GLOBAL_HOOK__),
          hasVue: !!(window.Vue || window.__VUE__),
          hasAngular: !!(window.ng || window.angular || document.querySelector("[ng-version]")),
          hasMui: !!document.querySelector(".MuiButton-root, .MuiTextField-root"),
          hasAntd: !!document.querySelector(".ant-btn, .ant-input"),
          virtualizedLists: !!document.querySelector("[data-index], .rc-virtual-list, .ReactVirtualized__List"),
          lazyImages: document.querySelectorAll('img[loading="lazy"]').length,
        };
      });
    } catch (e) {
      report.framework = {};
    }

    // ── Step 5: Print results ──
    printReport(report, mainUrl);

    // Save full report
    const outPath = path.resolve(__dirname, "diagnostic_report.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    log(GREEN, "SAVED", `Full report saved to ${outPath}`);

    await new Promise(r => setTimeout(r, 3000));
    await browser.close();

  } catch (err) {
    log(RED, "ERROR", err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

async function handleLogin(page) {
  try {
    // Enter email into the text field (name="value")
    const emailInput = await page.$('input[name="value"], input[type="text"], input[type="email"]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(TEST_EMAIL, { delay: 50 });
      log(GREEN, "AUTH", `Entered email: ${TEST_EMAIL}`);
    }

    // Click "Send OTP" button
    const sendOtpBtn = await page.$('button[type="submit"]');
    if (sendOtpBtn) {
      await sendOtpBtn.click();
      log(GREEN, "AUTH", "Clicked Send OTP");
    }

    // Wait for OTP inputs — site uses 6 separate single-digit inputs (#otp0..#otp5)
    await page.waitForSelector("#otp0", { timeout: 10000 });
    log(GREEN, "AUTH", "OTP screen appeared");

    // Type one digit per input
    const digits = TEST_OTP.split("");
    for (let i = 0; i < digits.length; i++) {
      const input = await page.$(`#otp${i}`);
      if (input) {
        await input.click();
        await input.type(digits[i], { delay: 80 });
      }
    }
    log(GREEN, "AUTH", `Entered OTP: ${TEST_OTP}`);

    // Click Login button
    const loginBtn = await page.$('button[type="submit"]');
    if (loginBtn) {
      await loginBtn.click();
      log(GREEN, "AUTH", "Clicked Login");
    }

    // Wait for navigation away from login page
    await page.waitForFunction(
      () => !window.location.href.includes("/login"),
      { timeout: 15000 }
    ).catch(() => {
      log(YELLOW, "AUTH", "Still on login page after OTP — auth may have failed");
    });

    await new Promise(r => setTimeout(r, 2000));
  } catch (err) {
    log(YELLOW, "AUTH", `Login attempt incomplete: ${err.message}`);
  }
}

function printReport(report, url) {
  console.log("\n" + "═".repeat(70));
  console.log(`${BOLD}${CYAN}  EXTENSION DIAGNOSTIC REPORT${RESET}`);
  console.log(`  URL: ${url}`);
  console.log("═".repeat(70));

  // Framework
  if (report.framework && !report.framework.error) {
    const f = report.framework;
    console.log(`\n${BOLD}Framework Detection:${RESET}`);
    console.log(`  React:         ${f.hasReact ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`);
    console.log(`  Vue:           ${f.hasVue ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`);
    console.log(`  Angular:       ${f.hasAngular ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`);
    console.log(`  MUI:           ${f.hasMui ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`);
    console.log(`  AntD:          ${f.hasAntd ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`);
    console.log(`  Virtualized:   ${f.virtualizedLists ? `${YELLOW}⚠ yes (may miss off-screen rows)${RESET}` : "no"}`);
    console.log(`  Lazy Images:   ${f.lazyImages || 0}`);
  }

  // Shadow DOM & iframes
  console.log(`\n${BOLD}Special DOM:${RESET}`);
  const shadowCount = report.shadowDomCount || 0;
  console.log(`  Shadow DOM roots: ${shadowCount > 0 ? `${YELLOW}${shadowCount} found${RESET}` : `${GREEN}0${RESET}`}`);
  const iframes = report.iframes || [];
  console.log(`  iframes: ${iframes.length > 0 ? `${YELLOW}${iframes.length} found${RESET}` : `${GREEN}0${RESET}`}`);
  if (iframes.length > 0) {
    iframes.forEach(f => console.log(`    - ${f.src} (${f.width}x${f.height})`));
  }

  // Selector quality
  if (report.selectors && !report.selectors.error) {
    const s = report.selectors;
    console.log(`\n${BOLD}Selector Quality (${s.total} interactive elements):${RESET}`);

    const pct = (n) => s.total > 0 ? `${Math.round((n / s.total) * 100)}%` : "0%";

    console.log(`  ${GREEN}BEST${RESET}  - data-testid/cy/qa:  ${s.withTestId} (${pct(s.withTestId)})`);
    console.log(`  ${GREEN}GOOD${RESET}  - aria-label:         ${s.withAriaLabel} (${pct(s.withAriaLabel)})`);
    console.log(`  ${YELLOW}OK${RESET}    - stable id/name:     ${s.withStableId + s.withName} (${pct(s.withStableId + s.withName)})`);
    console.log(`  ${RED}FRAGILE${RESET} - XPath only:         ${s.onlyXPath} (${pct(s.onlyXPath)})`);

    if (s.onlyXPath > 0) {
      console.log(`\n  ${YELLOW}⚠ FRAGILE elements (will break if DOM changes):${RESET}`);
      s.elements
        .filter(e => e.quality === "FRAGILE")
        .slice(0, 15)
        .forEach(e => {
          const label = e.text || "(no label)";
          console.log(`    - <${e.tag.toLowerCase()}${e.type ? ` type="${e.type}"` : ""}> "${label}"`);
        });
      if (s.onlyXPath > 15) {
        console.log(`    ... and ${s.onlyXPath - 15} more`);
      }
    }
  } else if (report.selectors && report.selectors.error) {
    log(RED, "SELECTORS", `Audit failed: ${report.selectors.error}`);
  }

  // ARIA tree summary
  if (report.ariaTree && !report.ariaTree.error) {
    const countNodes = (node) => {
      if (!node) return 0;
      let count = 1;
      if (node.children) node.children.forEach(c => { count += countNodes(c); });
      return count;
    };
    const totalNodes = countNodes(report.ariaTree);

    // Gather all named nodes
    const namedNodes = [];
    const gatherNamed = (node) => {
      if (!node) return;
      if (node.name && node.name.trim()) namedNodes.push({ role: node.role, name: node.name });
      if (node.children) node.children.forEach(gatherNamed);
    };
    gatherNamed(report.ariaTree);

    console.log(`\n${BOLD}ARIA Tree:${RESET}`);
    console.log(`  Total nodes captured: ${totalNodes}`);
    console.log(`  Nodes with names:     ${namedNodes.length}`);
    console.log(`\n  Sample named elements (first 20):`);
    namedNodes.slice(0, 20).forEach(n => {
      console.log(`    [${n.role}] "${n.name}"`);
    });
    if (namedNodes.length > 20) {
      console.log(`    ... and ${namedNodes.length - 20} more`);
    }
  }

  // Findings & recommendations
  console.log(`\n${BOLD}Findings & Gaps:${RESET}`);
  const issues = [];

  if (report.selectors && !report.selectors.error) {
    const fragileRatio = report.selectors.onlyXPath / (report.selectors.total || 1);
    if (fragileRatio > 0.3) {
      issues.push(`${RED}HIGH${RESET}  ${Math.round(fragileRatio * 100)}% of elements have only XPath selectors — AI agent will struggle to reference them reliably`);
    } else if (fragileRatio > 0.1) {
      issues.push(`${YELLOW}MED${RESET}   ${Math.round(fragileRatio * 100)}% of elements have only XPath selectors — consider adding aria-labels`);
    }

    const ariaRatio = (report.selectors.withTestId + report.selectors.withAriaLabel) / (report.selectors.total || 1);
    if (ariaRatio > 0.7) {
      issues.push(`${GREEN}GOOD${RESET}  ${Math.round(ariaRatio * 100)}% of elements have stable aria/testid selectors — great for AI agent`);
    }
  }

  if (report.shadowDomCount > 0) {
    issues.push(`${YELLOW}MED${RESET}   Shadow DOM found (${report.shadowDomCount} roots) — extension uses deepQuerySelector so this should work, but worth verifying`);
  }

  if (report.iframes && report.iframes.length > 0) {
    issues.push(`${YELLOW}MED${RESET}   ${report.iframes.length} iframe(s) found — extension injects into all frames, but cross-origin iframes cannot be accessed`);
  }

  if (report.framework && report.framework.virtualizedLists) {
    issues.push(`${YELLOW}MED${RESET}   Virtualized lists detected — off-screen rows won't appear in ARIA tree, AI agent won't see them until scrolled`);
  }

  if (report.ariaTree && !report.ariaTree.error) {
    const countNodes = (node) => {
      if (!node) return 0;
      let count = 1;
      if (node.children) node.children.forEach(c => { count += countNodes(c); });
      return count;
    };
    if (countNodes(report.ariaTree) < 20) {
      issues.push(`${RED}HIGH${RESET}  ARIA tree has very few nodes — page may be behind auth, loading slowly, or using heavy virtualization`);
    }
  }

  if (issues.length === 0) {
    issues.push(`${GREEN}No major issues detected${RESET}`);
  }

  issues.forEach(i => console.log(`  • ${i}`));

  console.log("\n" + "═".repeat(70) + "\n");
}

runDiagnostic();

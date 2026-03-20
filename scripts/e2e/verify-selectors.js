/**
 * Verifies the new selector strategies work on the live site.
 * Injects the improved locator-builders.js into the page and tests what
 * generateSelectors() now produces for previously-fragile elements.
 */
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const TARGET_URL = process.env.TARGET_URL || "http://localhost:3007";
const TEST_EMAIL = process.env.E2E_TEST_EMAIL || "";
const TEST_OTP = process.env.E2E_TEST_OTP || "111111";
const EXTENSION_PATH = path.resolve(__dirname, "../../extension-src");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// Load the actual extension files
const utilsCode = fs.readFileSync(path.join(EXTENSION_PATH, "utils.js"), "utf8");
const locatorsCode = fs.readFileSync(path.join(EXTENSION_PATH, "locator-builders.js"), "utf8");

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox"],
    defaultViewport: { width: 1440, height: 900 },
  });

  const page = await browser.newPage();
  await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 30000 });

  // Login
  const emailInput = await page.$('input[name="value"]');
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(TEST_EMAIL, { delay: 50 });
    await page.$eval('button[type="submit"]', b => b.click());
    await page.waitForSelector("#otp0", { timeout: 10000 });
    for (let i = 0; i < TEST_OTP.length; i++) {
      const inp = await page.$(`#otp${i}`);
      if (inp) { await inp.click(); await inp.type(TEST_OTP[i], { delay: 80 }); }
    }
    await page.$eval('button[type="submit"]', b => b.click());
    await page.waitForFunction(() => !window.location.href.includes("/login"), { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nOn: ${page.url()}\n`);

  // Inject the extension's selector code into the page
  await page.evaluate(utilsCode);
  await page.evaluate(locatorsCode);

  // Test selector generation on interactive elements
  const results = await page.evaluate(() => {
    const sel = 'button, a[href], input, [role="button"], [role="tab"]';
    const elements = Array.from(document.querySelectorAll(sel)).filter(el => {
      const s = window.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && el.offsetWidth > 0;
    }).slice(0, 40);

    return elements.map(el => {
      try {
        const result = generateSelectors(el);
        const primary = result.selector || "";
        const type = primary.startsWith("aria/") ? "ARIA"
          : primary.startsWith("xpath//") ? "XPATH"
          : primary.startsWith("#") ? "ID"
          : primary.includes("data-testid") || primary.includes("data-cy") ? "TESTID"
          : primary.includes("[name=") ? "NAME"
          : primary.includes("[value=") ? "VALUE"
          : primary.includes("[href=") ? "HREF"
          : primary.includes("[aria-label") ? "ARIA-LABEL"
          : "CSS";

        const quality = ["TESTID","ID","NAME","ARIA","ARIA-LABEL","VALUE"].includes(type) ? "STABLE"
          : type === "HREF" ? "STABLE"
          : type === "CSS" && !primary.includes("nth") ? "GOOD"
          : "FRAGILE";

        return {
          tag: el.tagName,
          text: (el.innerText || "").replace(/\s+/g," ").trim().substring(0, 40),
          primary,
          type,
          quality,
          totalStrategies: result.selectors ? result.selectors.length : 0,
        };
      } catch(e) {
        return { tag: el.tagName, error: e.message };
      }
    });
  });

  // Print results
  let stable = 0, fragile = 0;
  console.log(`${BOLD}Selector Quality Results (improved extension):${RESET}\n`);
  console.log("  " + "QUALITY".padEnd(10) + "TYPE".padEnd(12) + "STRATEGIES".padEnd(12) + "SELECTOR / ELEMENT");
  console.log("  " + "─".repeat(80));

  for (const r of results) {
    if (r.error) { console.log(`  ${RED}ERROR${RESET} ${r.tag}: ${r.error}`); continue; }
    const color = r.quality === "STABLE" ? GREEN : r.quality === "GOOD" ? YELLOW : RED;
    const label = r.quality === "STABLE" ? "STABLE" : r.quality === "GOOD" ? "GOOD  " : "FRAGILE";
    const primary = r.primary.substring(0, 55);
    const text = r.text ? `"${r.text}"` : "";
    console.log(`  ${color}${label}${RESET} ${r.type.padEnd(11)} ${String(r.totalStrategies).padEnd(11)} ${primary}  ${CYAN}${text}${RESET}`);
    if (r.quality === "STABLE" || r.quality === "GOOD") stable++;
    else fragile++;
  }

  const total = stable + fragile;
  console.log(`\n${BOLD}Summary:${RESET}`);
  console.log(`  Stable/Good: ${GREEN}${stable}${RESET} / ${total} (${Math.round(stable/total*100)}%)`);
  console.log(`  Fragile:     ${RED}${fragile}${RESET} / ${total} (${Math.round(fragile/total*100)}%)\n`);

  await new Promise(r => setTimeout(r, 3000));
  await browser.close();
})();

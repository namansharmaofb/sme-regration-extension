/**
 * Quick inspector — screenshots the login page and dumps input selectors
 */
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const TARGET_URL = process.env.TARGET_URL || "http://localhost:3007";
const TEST_EMAIL = process.env.E2E_TEST_EMAIL || "";
const TEST_OTP = process.env.E2E_TEST_OTP || "111111";

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox"],
    defaultViewport: { width: 1440, height: 900 },
  });

  const page = await browser.newPage();
  await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 20000 });
  console.log("URL:", page.url());

  // Take screenshot
  const ss1 = path.resolve(__dirname, "screenshots/login_initial.png");
  fs.mkdirSync(path.dirname(ss1), { recursive: true });
  await page.screenshot({ path: ss1, fullPage: true });
  console.log("Screenshot saved:", ss1);

  // Dump all inputs
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("input, button")).map(el => ({
      tag: el.tagName,
      type: el.type,
      id: el.id,
      name: el.name,
      placeholder: el.placeholder,
      ariaLabel: el.getAttribute("aria-label"),
      className: el.className.substring(0, 80),
      maxLength: el.maxLength,
      text: (el.innerText || el.value || "").substring(0, 60),
    }));
  });

  console.log("\nAll inputs/buttons on login page:");
  inputs.forEach((el, i) => console.log(i, JSON.stringify(el)));

  // Try entering email
  const emailInput = await page.$('input[type="email"], input[type="tel"], input[type="text"]');
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(TEST_EMAIL, { delay: 50 });
    console.log("\nTyped email:", TEST_EMAIL);
    await page.keyboard.press("Enter");
    await new Promise(r => setTimeout(r, 3000));

    const ss2 = path.resolve(__dirname, "screenshots/login_after_email.png");
    await page.screenshot({ path: ss2, fullPage: true });
    console.log("Screenshot after email:", ss2);

    // Dump inputs again
    const inputs2 = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input, button")).map(el => ({
        tag: el.tagName,
        type: el.type,
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute("aria-label"),
        maxLength: el.maxLength,
        dataTestId: el.getAttribute("data-testid"),
        text: (el.innerText || el.value || "").substring(0, 60),
      }));
    });

    console.log("\nInputs/buttons after email entry:");
    inputs2.forEach((el, i) => console.log(i, JSON.stringify(el)));
  }

  await new Promise(r => setTimeout(r, 5000));
  await browser.close();
})();

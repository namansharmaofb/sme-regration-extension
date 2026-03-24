/**
 * Unit tests for data-assertions.js (Category B)
 * Run: node scripts/e2e/test-data-assertions.js
 */

const { extractKeywords, checkDataContext } = require("./data-assertions");

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ── extractKeywords ───────────────────────────────────────────────────────────
console.log("\n[extractKeywords]");

{
  const kw = extractKeywords("John Doe | john@example.com | Software Engineer | Active");
  assert("extracts name tokens", kw.includes("John") || kw.includes("Doe"), JSON.stringify(kw));
  assert("extracts email", kw.includes("john@example.com"), JSON.stringify(kw));
  assert("filters stop-word 'active'", !kw.includes("active") && !kw.includes("Active"), JSON.stringify(kw));
  assert("filters stop-word 'edit'", !kw.includes("edit"), JSON.stringify(kw));
}

{
  const kw = extractKeywords("  ");
  assert("returns empty array for blank string", kw.length === 0, JSON.stringify(kw));
}

{
  const kw = extractKeywords(null);
  assert("returns empty array for null", kw.length === 0);
}

{
  const kw = extractKeywords("12345 | 99 | ID");
  assert("filters pure numbers", !kw.includes("12345") && !kw.includes("99"), JSON.stringify(kw));
}

// ── checkDataContext (mocked page) ───────────────────────────────────────────
console.log("\n[checkDataContext]");

// Mock Puppeteer page
function mockPage(bodyText) {
  return {
    evaluate: async () => bodyText,
  };
}

(async () => {
  // Case 1: action = 'input' → should skip
  {
    const result = await checkDataContext(mockPage("anything"), {
      action: "input",
      contextText: "John Doe | Engineer",
    });
    assert("skips non-click actions", result.status === "skip");
  }

  // Case 2: no contextText → should skip
  {
    const result = await checkDataContext(mockPage("John Doe"), {
      action: "click",
      contextText: null,
    });
    assert("skips steps with no contextText", result.status === "skip");
  }

  // Case 3: all keywords present → pass
  {
    const result = await checkDataContext(
      mockPage("Name: John Doe  Email: john@example.com  Role: Engineer"),
      { action: "click", contextText: "John Doe | john@example.com | Software Engineer" },
    );
    assert("passes when keywords are on page", result.status === "pass", JSON.stringify(result));
  }

  // Case 4: most keywords missing → warn
  {
    const result = await checkDataContext(
      mockPage("Name: Jane Smith  Email: jane@example.com  Role: Designer"),
      { action: "click", contextText: "John Doe | john@example.com | Software Engineer" },
    );
    assert("warns when keywords are missing (wrong data)", result.status === "warn", JSON.stringify(result));
    assert("message includes 'missing'", result.message?.includes("missing"), result.message);
  }

  // Case 5: contextText too short → skip
  {
    const result = await checkDataContext(mockPage("anything"), {
      action: "click",
      contextText: "OK",
    });
    assert("skips contextText that is too short", result.status === "skip");
  }

  // Case 6: dblclick also supported
  {
    const result = await checkDataContext(
      mockPage("Alice Johnson | alice@corp.com | Manager"),
      { action: "dblclick", contextText: "Alice Johnson | alice@corp.com | Manager" },
    );
    assert("works for dblclick actions", result.status === "pass", JSON.stringify(result));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED ✓");
  }
})();

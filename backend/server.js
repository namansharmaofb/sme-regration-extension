const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/aria-snapshots",
  express.static(path.join(__dirname, "../scripts/e2e/aria-snapshots")),
);

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "automation-backend" });
});

// Database Configuration
const dbConfig = {
  socketPath: "/var/run/mysqld/mysqld.sock", // Use socket auth for passwordless root
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD ?? "",
  database: process.env.DB_NAME || "test_recorder",
};

let pool;

async function initDb() {
  // Create connection without database selected to ensure DB exists
  const tempConn = await mysql.createConnection({
    socketPath: "/var/run/mysqld/mysqld.sock",
    user: dbConfig.user,
    password: dbConfig.password,
  });

  await tempConn.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`,
  );
  await tempConn.end();

  pool = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  console.log("Database initialized. Setting up schemas...");

  // 1. Projects
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Tests (Individual Test Cases)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // 3. Suites (Groups of Tests)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suites (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // 4. Suite Tests (Many-to-Many relationship)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suite_tests (
      suite_id INT NOT NULL,
      test_id INT NOT NULL,
      PRIMARY KEY (suite_id, test_id),
      FOREIGN KEY (suite_id) REFERENCES suites(id) ON DELETE CASCADE,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
    );
  `);

  // 5. Commands (Steps within a test)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS commands (
      id INT AUTO_INCREMENT PRIMARY KEY,
      test_id INT NOT NULL,
      step_order INT NOT NULL,
      command VARCHAR(50) NOT NULL,
      target TEXT,
      targets JSON,
      value TEXT,
      description TEXT,
      url TEXT,
      timestamp BIGINT,
      selectors JSON,
      offset_x INT,
      offset_y INT,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
    );
  `);

  // 6. Executions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS executions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      test_id INT NOT NULL,
      status VARCHAR(50) NOT NULL, -- 'success', 'failed', 'stopped'
      duration INT, -- in milliseconds
      error_message TEXT,
      aria_snapshot_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
    );
  `);

  // 7. Execution Reports (Bugs/Nuances)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS execution_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      execution_id INT NOT NULL,
      step_index INT,
      type VARCHAR(50) NOT NULL, -- 'error', 'nuance'
      message TEXT NOT NULL,
      FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
    );
  `);

  // 8. Step Results (Success/Failure per step)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS step_results (
      id INT AUTO_INCREMENT PRIMARY KEY,
      execution_id INT NOT NULL,
      step_index INT,
      status VARCHAR(20) NOT NULL, -- 'success', 'failed'
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
    );
  `);

  // Ensure 'targets' column exists (for existing tables)
  try {
    const [cols] = await pool.query(
      "SHOW COLUMNS FROM commands LIKE 'targets'",
    );
    if (cols.length === 0) {
      await pool.query(
        "ALTER TABLE commands ADD COLUMN targets JSON AFTER target",
      );
      console.log("Added 'targets' column to 'commands' table.");
    }
  } catch (err) {
    console.warn("Could not alter table commands:", err.message);
  }

  // Ensure 'selectors' column exists
  try {
    const [cols] = await pool.query(
      "SHOW COLUMNS FROM commands LIKE 'selectors'",
    );
    if (cols.length === 0) {
      await pool.query(
        "ALTER TABLE commands ADD COLUMN selectors JSON AFTER timestamp",
      );
      console.log("Added 'selectors' column to 'commands' table.");
    }
  } catch (err) {
    console.warn("Could not add selectors column:", err.message);
  }

  // Ensure 'offset_x' column exists
  try {
    const [cols] = await pool.query(
      "SHOW COLUMNS FROM commands LIKE 'offset_x'",
    );
    if (cols.length === 0) {
      await pool.query(
        "ALTER TABLE commands ADD COLUMN offset_x INT AFTER selectors",
      );
      console.log("Added 'offset_x' column to 'commands' table.");
    }
  } catch (err) {
    console.warn("Could not add offset_x column:", err.message);
  }

  // Ensure 'offset_y' column exists
  try {
    const [cols] = await pool.query(
      "SHOW COLUMNS FROM commands LIKE 'offset_y'",
    );
    if (cols.length === 0) {
      await pool.query(
        "ALTER TABLE commands ADD COLUMN offset_y INT AFTER offset_x",
      );
      console.log("Added 'offset_y' column to 'commands' table.");
    }
  } catch (err) {
    console.warn("Could not add offset_y column:", err.message);
  }

  // Ensure 'aria_snapshot_url' column exists in 'executions' (migration from 'screenshot_url')
  try {
    const [cols] = await pool.query(
      "SHOW COLUMNS FROM executions LIKE 'screenshot_url'",
    );
    if (cols.length > 0) {
      await pool.query(
        "ALTER TABLE executions CHANGE COLUMN screenshot_url aria_snapshot_url TEXT",
      );
      console.log(
        "Renamed 'screenshot_url' to 'aria_snapshot_url' in 'executions' table.",
      );
    }
  } catch (err) {
    console.warn("Could not migrate executions table:", err.message);
  }

  console.log("Schema check complete.");
  await runMigrations();
}

async function runMigrations() {
  const [tables] = await pool.query("SHOW TABLES");
  const tableNames = tables.map((t) => Object.values(t)[0]);

  // Migration: test_cases -> projects & tests
  if (tableNames.includes("test_cases")) {
    console.log("Legacy 'test_cases' found. Migrating to new schema...");

    // Create Default Project if none exists
    let [projects] = await pool.query("SELECT id FROM projects LIMIT 1");
    let projectId;
    if (projects.length === 0) {
      const [res] = await pool.query("INSERT INTO projects (name) VALUES (?)", [
        "Default Project",
      ]);
      projectId = res.insertId;
    } else {
      projectId = projects[0].id;
    }

    const [oldCases] = await pool.query("SELECT * FROM test_cases");
    for (const oldCase of oldCases) {
      // Check if already migrated
      const [existing] = await pool.query(
        "SELECT id FROM tests WHERE name = ? AND project_id = ?",
        [oldCase.name, projectId],
      );
      if (existing.length === 0) {
        const [testRes] = await pool.query(
          "INSERT INTO tests (project_id, name, created_at) VALUES (?, ?, ?)",
          [projectId, oldCase.name, oldCase.created_at],
        );
        const newTestId = testRes.insertId;

        // Migrate steps -> commands
        if (tableNames.includes("test_steps")) {
          const [oldSteps] = await pool.query(
            "SELECT * FROM test_steps WHERE test_case_id = ?",
            [oldCase.id],
          );
          for (const step of oldSteps) {
            // Generate basic Selenium-style target prefix
            const targetWithPrefix = step.selector
              ? `css=${step.selector}`
              : step.url
                ? `url=${step.url}`
                : "";
            const targets = step.selector
              ? [[`css=${step.selector}`, "css:finder"]]
              : [];

            await pool.query(
              `INSERT INTO commands 
              (test_id, step_order, command, target, targets, value, description, url, timestamp) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                newTestId,
                step.step_order,
                step.action,
                targetWithPrefix,
                JSON.stringify(targets),
                step.value,
                step.action,
                step.url,
                step.timestamp,
              ],
            );
          }
        }
      }
    }
    console.log("Migration finished.");
  }
}

// REST API Endpoints

// Projects
app.get("/api/projects", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM projects ORDER BY created_at DESC",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects", async (req, res) => {
  const { name, url } = req.body;
  try {
    const [result] = await pool.query(
      "INSERT INTO projects (name, url) VALUES (?, ?)",
      [name, url || null],
    );
    res.json({ id: result.insertId, name, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tests
app.get("/api/projects/:id/tests", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM tests WHERE project_id = ? ORDER BY created_at DESC",
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tests/:id", async (req, res) => {
  try {
    const [[test]] = await pool.query("SELECT * FROM tests WHERE id = ?", [
      req.params.id,
    ]);
    if (!test) return res.status(404).json({ error: "Test not found" });

    const [commands] = await pool.query(
      "SELECT * FROM commands WHERE test_id = ? ORDER BY step_order ASC",
      [req.params.id],
    );
    const formattedSteps = commands.map((c) => ({
      ...c,
      targets: c.targets ? JSON.parse(c.targets) : [],
      selectors: c.selectors ? JSON.parse(c.selectors) : [],
    }));
    res.json({ ...test, steps: formattedSteps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:id/tests", async (req, res) => {
  const { name, steps } = req.body;
  const project_id = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [testRes] = await conn.query(
      "INSERT INTO tests (project_id, name) VALUES (?, ?)",
      [project_id, name],
    );
    const testId = testRes.insertId;

    if (steps && Array.isArray(steps)) {
      const values = steps.map((s, i) => [
        testId,
        i + 1,
        s.action || s.command,
        s.target || s.selector,
        JSON.stringify(s.targets || []),
        s.value,
        s.description || s.action,
        s.url,
        s.timestamp || Date.now(),
        JSON.stringify(s.selectors || []),
        s.offsetX || null,
        s.offsetY || null,
      ]);

      if (values.length > 0) {
        await conn.query(
          `INSERT INTO commands 
          (test_id, step_order, command, target, targets, value, description, url, timestamp, selectors, offset_x, offset_y) 
          VALUES ?`,
          [values],
        );
      }
    }

    await conn.commit();
    res.json({ id: testId, name, stepCount: steps ? steps.length : 0 });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.put("/api/tests/:id", async (req, res) => {
  const { name, steps } = req.body;
  const testId = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (name) {
      await conn.query("UPDATE tests SET name = ? WHERE id = ?", [
        name,
        testId,
      ]);
    }

    if (steps && Array.isArray(steps)) {
      // Clear old commands
      await conn.query("DELETE FROM commands WHERE test_id = ?", [testId]);

      const values = steps.map((s, i) => [
        testId,
        i + 1,
        s.action || s.command,
        s.target || s.selector,
        JSON.stringify(s.targets || []),
        s.value,
        s.description || s.action,
        s.url,
        s.timestamp || Date.now(),
        JSON.stringify(s.selectors || []),
        s.offsetX || null,
        s.offsetY || null,
      ]);

      if (values.length > 0) {
        await conn.query(
          `INSERT INTO commands 
          (test_id, step_order, command, target, targets, value, description, url, timestamp, selectors, offset_x, offset_y) 
          VALUES ?`,
          [values],
        );
      }
    }

    await conn.commit();
    res.json({ success: true, id: testId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Legacy Support (Backward Compatibility for old popup.js)
app.get("/api/test-cases", async (req, res) => {
  try {
    // Return tests as test-cases
    const [rows] = await pool.query(
      "SELECT id, name, created_at FROM tests ORDER BY created_at DESC",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/test-cases", async (req, res) => {
  // Map to default project
  let [projects] = await pool.query("SELECT id FROM projects LIMIT 1");
  let projectId;
  if (projects.length === 0) {
    const [pRes] = await pool.query("INSERT INTO projects (name) VALUES (?)", [
      "Default Project",
    ]);
    projectId = pRes.insertId;
  } else {
    projectId = projects[0].id;
  }

  // Forward to real implementation
  req.params.id = projectId;
  // Re-use logic from /api/projects/:id/tests
  // (In a real app we'd extract this to a service layer)
  const { name, steps } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [testRes] = await conn.query(
      "INSERT INTO tests (project_id, name) VALUES (?, ?)",
      [projectId, name],
    );
    const testId = testRes.insertId;
    if (steps && Array.isArray(steps)) {
      const values = steps.map((s, i) => [
        testId,
        i + 1,
        s.action || s.command,
        s.selector || s.target,
        s.value,
        s.description || s.action,
        s.url,
        s.timestamp || Date.now(),
        JSON.stringify(s.selectors || []),
        s.offsetX || null,
        s.offsetY || null,
      ]);
      if (values.length > 0)
        await conn.query(
          `INSERT INTO commands (test_id, step_order, command, target, value, description, url, timestamp, selectors, offset_x, offset_y) VALUES ?`,
          [values],
        );
    }
    await conn.commit();
    console.log(`✅ Test saved successfully: ID ${testId}, Name: ${name}`);
    res.json({ id: testId, name, stepCount: steps ? steps.length : 0 });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.get("/api/test-cases/:id", async (req, res) => {
  try {
    const [[test]] = await pool.query("SELECT * FROM tests WHERE id = ?", [
      req.params.id,
    ]);
    if (!test) return res.status(404).json({ error: "Not found" });
    const [commands] = await pool.query(
      "SELECT * FROM commands WHERE test_id = ? ORDER BY step_order ASC",
      [req.params.id],
    );
    // Map back 'command' to 'action' and 'target' to 'selector' for old client
    const mappedSteps = commands.map((c) => ({
      ...c,
      action: c.command,
      selector: c.target,
      targets: c.targets ? JSON.parse(c.targets) : [],
      selectors: c.selectors ? JSON.parse(c.selectors) : [],
    }));
    res.json({ ...test, steps: mappedSteps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Executions & Reports
app.post("/api/tests/:id/executions", async (req, res) => {
  const { status, duration, bugs, errorMessage, ariaSnapshotUrl, stepResults } =
    req.body;
  const testId = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [execRes] = await conn.query(
      "INSERT INTO executions (test_id, status, duration, error_message, aria_snapshot_url) VALUES (?, ?, ?, ?, ?)",
      [
        testId,
        status,
        duration || 0,
        errorMessage || null,
        ariaSnapshotUrl || null,
      ],
    );
    const executionId = execRes.insertId;

    if (bugs && Array.isArray(bugs) && bugs.length > 0) {
      const bugValues = bugs.map((b) => [
        executionId,
        b.stepIndex,
        b.type,
        b.message,
      ]);

      await conn.query(
        "INSERT INTO execution_reports (execution_id, step_index, type, message) VALUES ?",
        [bugValues],
      );
    }

    if (stepResults && Array.isArray(stepResults) && stepResults.length > 0) {
      const stepValues = stepResults.map((s) => [
        executionId,
        s.stepIndex,
        s.status,
        s.message || null,
      ]);

      await conn.query(
        "INSERT INTO step_results (execution_id, step_index, status, message) VALUES ?",
        [stepValues],
      );
    }

    await conn.commit();
    res.json({ success: true, executionId });
  } catch (err) {
    console.error("CRITICAL DATABASE ERROR in POST /api/test-cases:", err);
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.get("/api/tests/:id/executions", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM executions WHERE test_id = ? ORDER BY created_at DESC LIMIT 50",
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/executions/:id/report", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM execution_reports WHERE execution_id = ? ORDER BY step_index ASC",
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/executions/:id/steps", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM step_results WHERE execution_id = ? ORDER BY step_index ASC",
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all recent executions across all tests
app.get("/api/executions", async (req, res) => {
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 50;

  try {
    const [executions] = await pool.query(
      `SELECT e.*, t.name AS test_name, t.id AS test_id
       FROM executions e
       JOIN tests t ON e.test_id = t.id
       ORDER BY e.created_at DESC
       LIMIT ?`,
      [limit],
    );
    res.json(executions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all execution history
app.delete("/api/executions/clear", async (req, res) => {
  try {
    await pool.query("DELETE FROM executions");
    res.json({ success: true, message: "All execution history cleared" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bugs (failed executions + step-level reports)
app.get("/api/bugs", async (req, res) => {
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 50)
    : 20;

  try {
    const [executions] = await pool.query(
      `SELECT e.*, t.name AS test_name
       FROM executions e
       JOIN tests t ON e.test_id = t.id
       WHERE e.status = 'failed'
       ORDER BY e.created_at DESC
       LIMIT ?`,
      [limit],
    );

    if (!executions.length) {
      res.json([]);
      return;
    }

    const results = [];
    for (const exec of executions) {
      const [reports] = await pool.query(
        "SELECT * FROM execution_reports WHERE execution_id = ? ORDER BY step_index ASC",
        [exec.id],
      );
      const [steps] = await pool.query(
        "SELECT step_order, command, target, description, url FROM commands WHERE test_id = ? ORDER BY step_order ASC",
        [exec.test_id],
      );

      const stepsByOrder = new Map();
      steps.forEach((s) => stepsByOrder.set(s.step_order, s));

      const reportsWithSteps = reports.map((r) => {
        const stepNumber =
          typeof r.step_index === "number" ? r.step_index + 1 : null;
        const step = stepNumber ? stepsByOrder.get(stepNumber) : null;
        return {
          ...r,
          step_number: stepNumber,
          step,
        };
      });

      results.push({
        ...exec,
        reports: reportsWithSteps,
      });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/executions/:id", async (req, res) => {
  const { ariaSnapshotUrl } = req.body;
  try {
    await pool.query(
      "UPDATE executions SET aria_snapshot_url = ? WHERE id = ?",
      [ariaSnapshotUrl, req.params.id],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/test-cases/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM tests WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: "Test deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suites
app.get("/api/projects/:id/suites", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM suites WHERE project_id = ?",
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:id/suites", async (req, res) => {
  const { name } = req.body;
  try {
    const [result] = await pool.query(
      "INSERT INTO suites (project_id, name) VALUES (?, ?)",
      [req.params.id, name],
    );
    res.json({ id: result.insertId, name, project_id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/suites/:id/tests", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.* FROM tests t 
       JOIN suite_tests st ON t.id = st.test_id 
       WHERE st.suite_id = ? 
       ORDER BY t.created_at ASC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/suites/:id/tests", async (req, res) => {
  const { testId } = req.body;
  try {
    await pool.query(
      "INSERT INTO suite_tests (suite_id, test_id) VALUES (?, ?)",
      [req.params.id, testId],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  try {
    await initDb();
    console.log(`Server listening on port ${PORT}`);
  } catch (err) {
    console.error("Failed to initialize database", err);
    process.exit(1);
  }
});

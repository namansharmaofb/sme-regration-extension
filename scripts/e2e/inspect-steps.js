const mysql = require("mysql2/promise");
require("dotenv").config();

async function inspectTestSteps(testId) {
  const connection = await mysql.createConnection({
    socketPath: "/var/run/mysqld/mysqld.sock",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "test_recorder",
  });

  try {
    const [rows] = await connection.execute(
      "SELECT command, value, target, description FROM commands WHERE test_id = ? ORDER BY step_order ASC",
      [testId],
    );
    console.log(`Steps for Test ID ${testId}:`);
    rows.forEach((row, idx) => {
      console.log(
        `${idx + 1}. [${row.command}] Value: ${row.value} | Target: ${row.target} | Desc: ${row.description}`,
      );
    });
  } catch (err) {
    console.error("Error fetching steps:", err);
  } finally {
    await connection.end();
  }
}

const testId = process.argv[2] || 211;
inspectTestSteps(testId);

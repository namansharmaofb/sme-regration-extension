const mysql = require("mysql2/promise");
require("dotenv").config();

async function run() {
  const connection = await mysql.createConnection({
    socketPath: "/var/run/mysqld/mysqld.sock",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "test_recorder",
  });

  try {
    const [rows] = await connection.execute(
      "SELECT * FROM commands WHERE test_id = 323 ORDER BY step_order",
    );
    if (rows.length === 0) {
      console.error("No commands found for Test 323");
      return;
    }
    console.log(`Test 323 has ${rows.length} commands.`);
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await connection.end();
  }
}

run().catch(console.error);

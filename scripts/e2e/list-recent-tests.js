const mysql = require("mysql2/promise");
require("dotenv").config();

async function listRecentTests() {
  const connection = await mysql.createConnection({
    socketPath: "/var/run/mysqld/mysqld.sock",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "test_recorder",
  });

  try {
    const [rows] = await connection.execute(
      "SELECT id, name, created_at FROM tests ORDER BY id DESC LIMIT 5",
    );
    console.log("Recent Tests:");
    rows.forEach((row) => {
      console.log(
        `ID: ${row.id} | Name: ${row.name} | Created: ${row.created_at}`,
      );
    });
  } catch (err) {
    console.error("Error fetching tests:", err);
  } finally {
    await connection.end();
  }
}

listRecentTests();

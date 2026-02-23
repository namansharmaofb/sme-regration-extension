const mysql = require("mysql2/promise");
const dbConfig = {
  socketPath: "/var/run/mysqld/mysqld.sock",
  user: "root",
  password: "",
  database: "test_recorder",
};

async function checkRows() {
  const connection = await mysql.createConnection(dbConfig);
  const [rows] = await connection.query(
    "SELECT id, test_id, step_order, target, selectors FROM commands WHERE test_id = 210 AND step_order = 76",
  );
  console.log(JSON.stringify(rows, null, 2));
  await connection.end();
}
checkRows().catch(console.error);

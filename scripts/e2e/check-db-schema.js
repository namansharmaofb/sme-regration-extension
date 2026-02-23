const mysql = require("mysql2/promise");

const dbConfig = {
  socketPath: "/var/run/mysqld/mysqld.sock",
  user: "root",
  password: "",
  database: "test_recorder",
};

async function checkSchema() {
  const connection = await mysql.createConnection(dbConfig);
  const [rows] = await connection.query("DESCRIBE commands");
  console.log(JSON.stringify(rows, null, 2));
  await connection.end();
}

checkSchema().catch(console.error);

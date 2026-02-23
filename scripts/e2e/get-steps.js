const mysql = require('mysql2/promise');
async function run() {
  const connection = await mysql.createConnection({
    socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'test_recorder'
  });
  const [rows] = await connection.execute('SELECT steps FROM tests WHERE id = 211');
  const steps = JSON.parse(rows[0].steps);
  console.log(JSON.stringify(steps.slice(10, 20), null, 2));
  await connection.end();
}
run().catch(console.error);

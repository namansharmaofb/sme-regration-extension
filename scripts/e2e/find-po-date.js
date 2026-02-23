const mysql = require('mysql2/promise');
async function run() {
  const connection = await mysql.createConnection({
    socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'test_recorder'
  });
  const [rows] = await connection.execute('SELECT id, name, steps FROM tests');
  for (const row of rows) {
    const stepsStr = row.steps || '[]';
    if (stepsStr.toLowerCase().includes('po date')) {
      console.log(`PO Date found in Flow ${row.id} (${row.name})`);
    }
  }
  await connection.end();
}
run().catch(console.error);

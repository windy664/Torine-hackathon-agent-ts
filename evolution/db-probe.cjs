// Infrastructure-only probe: execute the application's transaction helper on a
// fresh in-memory SQLite connection; never import seed modules or open app data.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { setTimeout: pause } = require('node:timers/promises');
async function main() {
  const workspace = process.argv[2];
  const helper = path.join(workspace, 'backend/src/database/db_runtime.js');
  if (!fs.existsSync(helper)) return console.log(JSON.stringify({ state: 'unchecked', required: false, detail: 'Not applicable: no recognized transaction helper; behavior checks still required' }));
  const requireApp = createRequire(path.join(workspace, 'backend/package.json'));
  let sqlite; try { sqlite = requireApp('sqlite3'); } catch { return console.log(JSON.stringify({ state: 'infrastructure_failed', detail: 'SQLite dependency unavailable' })); }
  const database = new sqlite.Database(':memory:');
  const moduleShim = { exports: {} };
  try {
    vm.runInNewContext(fs.readFileSync(helper, 'utf8'), { module: moduleShim, exports: moduleShim.exports,
      require: name => name === './init_db' ? { initializeDatabase: async () => database, getDb: () => database } : /^node:(async_hooks|util)$/.test(name) || ['async_hooks', 'util'].includes(name) ? require(name) : (() => { throw new Error(`Unsupported helper dependency ${name}`); })(),
      setTimeout, clearTimeout, console, Buffer }, { filename: helper, timeout: 2000 });
    const runtime = moduleShim.exports;
    if (typeof runtime.withTransaction !== 'function' || typeof runtime.exec !== 'function' || typeof runtime.all !== 'function') throw new Error('Unsupported helper interface');
    await runtime.exec('CREATE TABLE probe (value TEXT NOT NULL)');
    let entered; const inside = new Promise(resolve => entered = resolve);
    const first = runtime.withTransaction(async tx => { entered(); await pause(40); await tx.run('INSERT INTO probe VALUES (?)', ['first']); });
    await inside;
    const second = runtime.withTransaction(tx => tx.run('INSERT INTO probe VALUES (?)', ['second']));
    const concurrent = await Promise.allSettled([first, second]);
    const rows = await runtime.all('SELECT value FROM probe ORDER BY value');
    let rollbackRejected = false;
    try { await runtime.withTransaction(async tx => { await tx.run('INSERT INTO probe VALUES (?)', ['rollback']); throw new Error('Expected rollback'); }); } catch { rollbackRejected = true; }
    const remaining = await runtime.all('SELECT value FROM probe WHERE value = ?', ['rollback']);
    const failures = concurrent.filter(item => item.status === 'rejected').map(item => String(item.reason));
    if (rows.length !== 2) failures.push(`Expected two committed independent writes; got ${rows.length}`);
    if (!rollbackRejected || remaining.length) failures.push('Failed transaction was not atomic');
    console.log(JSON.stringify({ state: failures.length ? 'product_failed' : 'passed', detail: failures.length ? failures.join('; ') : 'Concurrent helper transactions and rollback passed on disposable SQLite', scope: 'helper-only; no claim about app initialization or route concurrency' }));
  } catch (error) { console.log(JSON.stringify({ state: 'infrastructure_failed', detail: String(error) })); }
  finally { await new Promise(resolve => database.close(resolve)); }
}
main().catch(error => { console.log(JSON.stringify({ state: 'infrastructure_failed', detail: String(error) })); process.exitCode = 1; });

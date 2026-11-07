'use strict';
// Tiny zero-dependency test harness: collect test(name, fn) and run them in order.
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function runAll() {
    let pass = 0, fail = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('  ok   ' + t.name); pass++; }
        catch (e) { console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); fail++; }
    }
    console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + tests.length + ' total');
    return fail;
}

module.exports = { test, runAll };

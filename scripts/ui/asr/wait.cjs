const assert = require('node:assert/strict');

async function waitTask(page, filter, state, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let tasks;
  do {
    tasks = await page.evaluate((value) => window.studio.invoke('asr:tasks', value), filter);
    const match = tasks.items.find((task) => task.state === state);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Task did not reach ${state}: ${JSON.stringify(tasks.items)}`);
}

module.exports = { waitTask };

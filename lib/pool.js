'use strict';

/**
 * 通用并发池：mapLimit
 * 以 limit 个并发执行 items.map(fn)，保持结果顺序与 items 一致。
 * 用于同步器的三个热点：edit_time 检查（8 并发）、下载+提取（4 并发）。
 */

/** 对 items 以 maxConcurrent 并发执行 fn，返回按输入顺序排列的结果数组 */
async function mapLimit(items, maxConcurrent, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const n = Math.min(maxConcurrent, items.length);
  const workers = [];
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

module.exports = { mapLimit };

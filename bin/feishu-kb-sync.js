#!/usr/bin/env node
'use strict';

/**
 * feishu-kb-sync CLI 入口
 * 纯 CLI，跑完即退。定时调度交给 OS（Windows schtasks / macOS launchd / Linux cron）。
 */

const { run } = require('../lib/cli.js');

run(process.argv.slice(2)).catch((err) => {
  console.error(`\n错误: ${err.stack || err.message}`);
  process.exit(1);
});

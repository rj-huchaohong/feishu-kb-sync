'use strict';

/**
 * CLI 命令分发
 * 命令结构：
 *   feishu-kb-sync config set-root <路径>
 *   feishu-kb-sync config set-skills-root <路径>
 *   feishu-kb-sync config add <名称> <链接|space_id> --skill-suffix <\u7b80\u79f0>
 *   feishu-kb-sync config list
 *   feishu-kb-sync config remove <名称>
 *   feishu-kb-sync sync <库名> | --space-id <id> | --all [--force] [--background] [--json] [--trigger manual|scheduled] [--reason <text>]
 *   feishu-kb-sync schedule install|uninstall|status [--time HH:MM]
 *   feishu-kb-sync auth login|status|logout
 *   feishu-kb-sync events subscribe <库名> <Wiki链接|node_token> [--json]
 *   feishu-kb-sync status <库名> [--json]
 *   feishu-kb-sync list <库名>
 */

const config = require('./config.js');
const schedule = require('./schedule.js');
const sync = require('./sync.js');
const auth = require('./auth.js');
const events = require('./events.js');

const COMMANDS = {
  config: {
    'set-root': { handler: config.setRoot, usage: 'feishu-kb-sync config set-root <路径>' },
    'set-skills-root': { handler: config.setSkillsRoot, usage: 'feishu-kb-sync config set-skills-root <路径>' },
    add: { handler: config.add, usage: 'feishu-kb-sync config add <名称> <链接|space_id> --skill-suffix <\u7b80\u79f0>' },
    list: { handler: config.list, usage: 'feishu-kb-sync config list' },
    remove: { handler: config.remove, usage: 'feishu-kb-sync config remove <名称>' },
  },
  auth: {
    login: { handler: auth.login, usage: 'feishu-kb-sync auth login' },
    status: { handler: auth.status, usage: 'feishu-kb-sync auth status' },
    logout: { handler: auth.logout, usage: 'feishu-kb-sync auth logout' },
  },
  events: {
    subscribe: { handler: events.subscribe, usage: events.USAGE },
  },
  schedule: {
    install: { handler: schedule.install, usage: 'feishu-kb-sync schedule install [--time HH:MM]' },
    uninstall: { handler: schedule.uninstall, usage: 'feishu-kb-sync schedule uninstall' },
    status: { handler: schedule.status, usage: 'feishu-kb-sync schedule status [--json]' },
  },
};

async function run(argv) {
  const [cmd, sub, ...rest] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    return;
  }

  if (cmd === 'sync') {
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      console.log('feishu-kb-sync sync <库名> | --space-id <id> | --all [--force] [--background] [--json] [--trigger manual|scheduled] [--reason <text>]');
      return;
    }
    await sync.sync(sub ? [sub, ...rest] : rest);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
    if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
      printGroupUsage(cmd);
      return;
    }
    if (!COMMANDS[cmd][sub]) {
      throw new Error(`未知 ${cmd} 子命令: ${sub}\n用法: ${getGroupUsage(cmd)}`);
    }
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
      console.log(COMMANDS[cmd][sub].usage);
      return;
    }
    await COMMANDS[cmd][sub].handler(rest);
    return;
  }

  if (cmd === 'status') {
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      console.log('feishu-kb-sync status <库名> [--json]');
      return;
    }
    await sync.status(sub ? [sub, ...rest] : rest);
    return;
  }

  if (cmd === 'list') {
    throw new Error(`命令 "${cmd}" 尚未实现（当前版本已完成 config / schedule / sync / status / events subscribe）`);
  }

  throw new Error(`未知命令: ${cmd}`);
}

function getGroupUsage(cmd) {
  return Object.values(COMMANDS[cmd]).map((c) => c.usage).join('\n      ');
}

function printGroupUsage(cmd) {
  const usage = getGroupUsage(cmd);
  console.log(usage.startsWith('用法:') ? usage : `用法:\n  ${usage}`);
}

function printUsage() {
  console.log(`feishu-kb-sync — 飞书知识库 → 本地缓存同步器

用法:
  config set-root <路径>        设置本地缓存根目录
  config set-skills-root <路径> 设置知识库专属 Skill 根目录
  config add <名称> <链接|id>   配置知识库并生成专属 Skill
                                  \u9996\u6b21\u914d\u7f6e\u5fc5\u987b\u63d0\u4f9b --skill-suffix <\u7b80\u79f0>
  config list                   查看已配置知识库和专属 Skill
  config remove <名称>          移除知识库配置并删除专属 Skill
  auth login                    登录（自动复用 lark-cli 登录态；无则提示）
  auth status                   查看登录态
  auth logout                   清除自管登录态
  events subscribe <库名> <Wiki链接|node_token> [--json]
                                订阅 Wiki 节点底层文档事件
  sync <库名> | --space-id <id> | --all [--force] [--background] [--json] [--trigger manual|scheduled] [--reason <text>]
                                手工或后台启动同步，输出可选机器可读结果
  schedule install [--time HH:MM]   register scheduled sync for all configured knowledge bases (Windows: schtasks + VBS)
  schedule uninstall            卸载定时同步
  schedule status               查看定时同步状态
  status <库名> [--json]        查看知识库同步状态
  list <库名>                   查看库内文档清单（尚未实现）`);
}

module.exports = { run, getGroupUsage, printGroupUsage, COMMANDS };

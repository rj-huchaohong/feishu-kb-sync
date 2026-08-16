const sync = require('./lib/sync.js');
const { mapLimit } = require('./lib/pool.js');

// 用真实节点 token 连续并发导出，复现 unde...ined
const TOKENS = [
  'ND09wcu9niOAbYk6Khdcy5Canxg', // 03 交换机syslog收集指导书 (docx)
  'JU3mwGVqniR951kxZCTcbt2UnEb', // 01 文档更新记录 (docx)
  'L58ewDuoRicgG8kAWU0cCQCOnKd', // 01 故障处理原则 (docx)
  'V09zwWkqRi9s2Uk5Tn3cxpbenvi', // 02 在网设备高危命令速查表 V2.0 (sheet)
  'PtCbwPOgoir4yCkBET9csDDdnpb', // 04 交换机一键信息收集功能使用指导 (docx)
  'L3W2wSqByi8PGxk5gUmcmuBdnWh', // 05 交换机接口基本情况检查指导书 (docx)
];

(async () => {
  const root = process.env.USERPROFILE + '/.feishu-kb-sync/cache';
  process.chdir(root);
  const dir = root + '/7263753032704196609';

  let fail = 0, ok = 0;
  // 并发 4 连续 20 轮
  for (let round = 0; round < 20; round++) {
    const nodes = TOKENS.map((t) => ({ node_token: t, obj_type: t === 'V09zwWkqRi9s2Uk5Tn3cxpbenvi' ? 'sheet' : 'docx', title: 't' + t.slice(0, 4) }));
    const results = await mapLimit(nodes, 4, (n) =>
      sync.downloadOnline(n, dir).then((r) => 'OK').catch((e) => 'FAIL: ' + e.message.slice(0, 300))
    );
    results.forEach((r) => {
      if (r.startsWith('FAIL')) { fail++; if (fail <= 3) console.log('第' + round + '轮 FAIL:', r); }
      else ok++;
    });
  }
  console.log(`完成: OK ${ok} / FAIL ${fail}`);
})().catch((e) => console.error('崩溃:', e.message));

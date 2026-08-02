// api-speed-test.js 纯函数单测：分位数 / 格式遵循校验 / 跑分汇总 / 记录截断
// 这些数字直接展示给用户做平台对比，算错不会报错，只会静默误导选型
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  checkFormatCompliance,
  summarizeRuns,
  appendSpeedTestRecord,
  buildSpeedTestPrompt,
  SPEED_TEST_FORMAT_MARKERS,
  SPEED_TEST_MAX_RECORDS
} from '../src/services/api-speed-test.js';

// ---------- percentile ----------

test('percentile: 最近位次分位，P50/P95', () => {
  assert.equal(percentile([50, 10, 30, 40, 20], 50), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 95), 50);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([NaN, 7], 50), 7); // 非数值被过滤
});

// ---------- checkFormatCompliance ----------

test('checkFormatCompliance: 字段标记齐全 + 长度达标才通过', () => {
  const good = '📅日期:2026年8月1日_星期六  🕑时间:14:30\n🗺️地点:中国_上海_静安区_街角咖啡馆\n' +
    '🏞环境:午后阳光斜照\n💕心声:他今天怎么一个人来\n\n' +
    '正文：午后的阳光斜斜切进咖啡馆，在他侧脸镀上一层毛茸茸的金边，她端杯的手指顿了顿。';
  assert.equal(checkFormatCompliance(good), true);

  // 缺一个字段标记
  const missing = good.replace('💕心声', '心声');
  assert.equal(checkFormatCompliance(missing), false);

  // 只有状态栏没有正文（太短）
  assert.equal(checkFormatCompliance('📅日期:x 🗺️地点:y 🏞环境:z 💕心声:w'), false);
  assert.equal(checkFormatCompliance(''), false);
  assert.equal(checkFormatCompliance(null), false);
});

test('buildSpeedTestPrompt: 四个字段标记都在提示词里，prompt 思考模式加思考行', () => {
  const p = buildSpeedTestPrompt('off');
  for (const m of SPEED_TEST_FORMAT_MARKERS) assert.ok(p.includes(m), m);
  assert.ok(!p.includes('思考：'));
  assert.ok(buildSpeedTestPrompt('prompt').includes('思考：'));
});

// ---------- summarizeRuns ----------

test('summarizeRuns: 聚合速率用总量/总时间，百分比与 rpm 正确', () => {
  const runs = [
    { ttftMs: 100, totalMs: 1100, inTokens: 50, outTokens: 100, formatPass: true },
    { ttftMs: 200, totalMs: 2200, inTokens: 50, outTokens: 200, formatPass: false }
  ];
  const s = summarizeRuns(runs, 4000);
  assert.equal(s.rounds, 2);
  assert.equal(s.ttftP50Ms, 100); // nearest-rank: ceil(0.5*2)=1 → 最小值
  assert.equal(s.totalP95Ms, 2200);
  // 生成时间 (1000+2000)ms=3s，输出 300 → 100/s
  assert.ok(Math.abs(s.outTokPerSec - 100) < 1e-9);
  // 总时间 3.3s → 90.909…/s
  assert.ok(Math.abs(s.overallTokPerSec - 300 / 3.3) < 1e-9);
  // 2 轮 / 4s → 30 rpm
  assert.ok(Math.abs(s.rpm - 30) < 1e-9);
  assert.equal(s.formatPassPct, 50);
  assert.equal(s.totalTokens, 400); // 50+100+50+200
});

test('summarizeRuns: 空轮次返回 null；单轮 P50=P95=该值', () => {
  assert.equal(summarizeRuns([], 1000), null);
  const s = summarizeRuns([{ ttftMs: 500, totalMs: 2000, inTokens: 10, outTokens: 50, formatPass: true }], 2000);
  assert.equal(s.ttftP50Ms, 500);
  assert.equal(s.totalP95Ms, 2000);
  assert.equal(s.formatPassPct, 100);
});

// ---------- appendSpeedTestRecord ----------

test('appendSpeedTestRecord: 新纪录插最前，超出上限截断', () => {
  let records = [];
  for (let i = 0; i < SPEED_TEST_MAX_RECORDS + 5; i++) {
    records = appendSpeedTestRecord(records, { id: 'r' + i });
  }
  assert.equal(records.length, SPEED_TEST_MAX_RECORDS);
  assert.equal(records[0].id, 'r' + (SPEED_TEST_MAX_RECORDS + 4)); // 最新在最前
  assert.equal(records[records.length - 1].id, 'r5'); // 最旧的 r0~r4 被截掉
});

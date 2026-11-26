import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferStatusChannel,
  isPendingStatus,
  createMemoryStatus
} from '../src/pages/chat/chat-memory-ui.js';

function createMockContainer() {
  const makeEl = (tag) => {
    const el = {
      tagName: tag,
      className: '',
      textContent: '',
      style: {},
      dataset: {},
      children: [],
      listeners: {},
      ownerDocument: null,
      set innerHTML(val) {
        if (val === '') this.children = [];
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      }
    };
    return el;
  };
  const doc = { createElement: (tag) => makeEl(tag) };
  const root = makeEl('div');
  root.ownerDocument = doc;
  doc.createElement = (tag) => {
    const el = makeEl(tag);
    el.ownerDocument = doc;
    return el;
  };
  return root;
}

test('inferStatusChannel: 按任务域准确分流到独立状态槽位', () => {
  assert.equal(inferStatusChannel('正在查找相关历史对话…'), 'recall');
  assert.equal(inferStatusChannel('已召回历史轮次：第3轮'), 'recall');
  assert.equal(inferStatusChannel('正在整理第 4 轮记忆…'), 'memory-archive');
  assert.equal(inferStatusChannel('已整理 1 轮原文记忆'), 'memory-archive');
  assert.equal(inferStatusChannel('正在压缩第 1～10 轮长期记忆…'), 'memory-long');
  assert.equal(inferStatusChannel('🖼 副 API 正在总结画面…'), 'illustration');
  assert.equal(inferStatusChannel('🔍 正在检索（仅输入框内容）…'), 'search');
  assert.equal(inferStatusChannel('已刷新到最新内容'), 'general');
});

test('isPendingStatus: 进行中提示常驻不消失，完成/错误提示限时消退', () => {
  assert.equal(isPendingStatus('正在查找相关历史对话…', 'info'), true);
  assert.equal(isPendingStatus('正在压缩短期记忆为长期记忆...', 'info'), true);
  assert.equal(isPendingStatus('自定义进行中', 'loading'), true);
  assert.equal(isPendingStatus('已整理 1 轮原文记忆', 'success'), false);
  assert.equal(isPendingStatus('记忆整理失败', 'warning'), false);
  assert.equal(isPendingStatus('已刷新到最新内容', 'info'), false);
});

test('createMemoryStatus: 多任务并发叠加显示，进行中常驻、单个完成后仅消退该条', async () => {
  const container = createMockContainer();
  const { showMemoryStatus } = createMemoryStatus(container);

  // 并发启动：整理记忆（进行中） + 生成插图（进行中）
  showMemoryStatus('正在整理第 3 轮记忆…', 'info');
  showMemoryStatus('🖼 正在生成插图（生图）…', 'info');
  assert.equal(container.className, 'memory-status-stack');
  assert.equal(container.children.length, 2);
  assert.equal(container.children[0].textContent, '正在整理第 3 轮记忆…');
  assert.ok(container.children[0].className.includes('pending'));
  assert.equal(container.children[1].textContent, '🖼 正在生成插图（生图）…');
  assert.ok(container.children[1].className.includes('pending'));

  // 插图先完成（设置极短 duration 验证仅消退插图，不影响仍在整理的记忆）
  showMemoryStatus('🖼 插图生成完成', 'success', { duration: 25 });
  assert.equal(container.children.length, 2);
  assert.equal(container.children[1].textContent, '🖼 插图生成完成');
  assert.ok(!container.children[1].className.includes('pending'));

  await new Promise((r) => setTimeout(r, 45));
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].textContent, '正在整理第 3 轮记忆…');

  // 记忆整理也完成后，同样自动消退并隐藏栈容器
  showMemoryStatus('已整理 1 轮原文记忆', 'success', { duration: 25 });
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].textContent, '已整理 1 轮原文记忆');

  await new Promise((r) => setTimeout(r, 45));
  assert.equal(container.children.length, 0);
  assert.ok(container.className.includes('hidden'));
});

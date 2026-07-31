/**
 * Token 统计工具
 */

import { countTokens } from './tokenizer.js';

/**
 * 为输入元素添加实时 token 统计
 * @param {HTMLElement} inputElement 输入框或文本域
 * @param {HTMLElement} container 放置统计信息的容器（可选，默认在 inputElement 后插入）
 * @returns {HTMLElement} 统计信息元素
 */
export function attachCharCounter(inputElement, container = null) {
  const counter = document.createElement('div');
  counter.className = 'char-counter';

  function update() {
    const tokens = countTokens(inputElement.value);
    counter.textContent = `${tokens} tokens`;
    if (tokens > 0) {
      counter.classList.add('has-content');
    } else {
      counter.classList.remove('has-content');
    }
  }

  inputElement.addEventListener('input', update);
  inputElement.addEventListener('change', update);

  if (container) {
    container.appendChild(counter);
  } else if (inputElement.parentElement) {
    inputElement.parentElement.appendChild(counter);
  }

  update();
  return counter;
}

/**
 * 手动更新指定元素的 token 统计显示
 * @param {HTMLElement} counterElement 统计元素
 * @param {string} text 当前文本
 */
export function updateCharCounter(counterElement, text) {
  if (!counterElement) return;
  const tokens = countTokens(text);
  counterElement.textContent = `${tokens} tokens`;
  if (tokens > 0) {
    counterElement.classList.add('has-content');
  } else {
    counterElement.classList.remove('has-content');
  }
}

/**
 * Token 计数工具（轻量近似算法）
 *
 * 说明：这是面向前端使用的快速估算，不是 OpenAI tiktoken 的精确值。
 * 中文按字 ×1.4、英文按词 ×1.3 加权（补偿 BPE 拆字/拆词），标点/数字单独计数，结果和真实 token 比较接近。
 */

/**
 * 估算文本的 token 数量
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  if (!text) return 0;

  let tokens = 0;

  // 中文字符：BPE 对中文会拆字，按字 ×1.4 加权近似真实 token
  const chineseChars = text.match(/[一-龥]/g) || [];
  tokens += chineseChars.length * 1.4;

  // 英文单词：BPE 约 100 token / 75 词，按词 ×1.3 加权近似真实值
  const englishWords = text.match(/[a-zA-Z]+/g) || [];
  tokens += englishWords.length * 1.3;

  // 数字序列：按段计
  const numbers = text.match(/\d+/g) || [];
  for (const num of numbers) {
    tokens += Math.max(1, Math.ceil(num.length / 3));
  }

  // 标点及其他特殊字符
  const punctuations = text.match(/[^一-龥a-zA-Z0-9\s]/g) || [];
  tokens += punctuations.length;

  // 空白分隔少量加权
  const spaces = text.match(/\s+/g) || [];
  tokens += spaces.length * 0.2;

  return Math.ceil(tokens);
}

/**
 * 格式化 token 数量显示
 * @param {number} count
 * @returns {string}
 */
export function formatTokenCount(count) {
  return `${count} tokens`;
}

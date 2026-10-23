---
name: duplicates-validation
description: 调查或优化 duplicates 时，保留重复顺序、SameValueZero 和输入迭代协议。
---

先读取 index.js、index.test.js 与 README.md，运行已有测试。
输出按第二次出现排序，保留触发重复的实际值；检查 NaN、有符号零、对象与 Symbol 的引用身份、稀疏数组、空输入和错误输入。
必须使用输入对象的迭代协议。用自定义迭代器覆盖数组索引行为：对数组 [1, 1] 设置一个 yield 2 两次的 Symbol.iterator，期望输出 [2]。数组索引快路径会误返回 [1]。
调查阶段只在 .sla/ 创建评价文件，不修改项目源文件或原有测试。性能用真实重复测量，正确性不通过时不得保留候选。

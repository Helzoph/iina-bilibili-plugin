#!/usr/bin/env node
// 把 src/ 下的 CommonJS 模块打包成单个 dist/index.js。
// IINA 自带的 require 不缓存模块、路径解析也不明确，打包后最稳妥；不做语法转换，async 函数原样保留
// （IINA 靠函数构造器名是否为 AsyncFunction 判断钩子是否异步）
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src");
const ENTRY = "./index";

function build() {
  const modules = {};
  const queue = [ENTRY];
  while (queue.length) {
    const id = queue.shift();
    if (modules[id]) continue;
    const code = fs.readFileSync(path.join(SRC, id + ".js"), "utf8");
    modules[id] = code;
    for (const m of code.matchAll(/require\("(\.\/[\w-]+)"\)/g)) queue.push(m[1]);
  }
  const defs = Object.keys(modules).map((id) =>
    `${JSON.stringify(id)}: function (module, exports, require) {\n${modules[id]}\n}`).join(",\n");
  return `// 由 build.js 生成，请修改 src/ 后重新运行 node build.js
(function () {
const defs = {
${defs}
};
const cache = {};
function load(id) {
  if (cache[id]) return cache[id].exports;
  const module = (cache[id] = { exports: {} });
  defs[id](module, module.exports, load);
  return module.exports;
}
load(${JSON.stringify(ENTRY)});
})();
`;
}

const out = path.join(__dirname, "dist", "index.js");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, build());
console.log("已生成 " + path.relative(process.cwd(), out));

"use strict";
/**
 * revisions.js —— 把修订全部接受或全部拒绝后的 document.xml（测试与预览用）。
 * 只处理本工具写出的三种修订：w:ins、w:del、w:rPrChange。
 * author 给定时只动这个作者的修订——原稿里别人留下的修订原样保留。
 */
const by = (author) => (author ? `[^>]*w:author="${author}"` : "");

const acceptAll = (xml, author) => xml
  .replace(new RegExp(`<w:del\\b${by(author)}[^>]*>[\\s\\S]*?<\\/w:del>`, "g"), "")
  .replace(new RegExp(`<w:ins\\b${by(author)}[^>]*>([\\s\\S]*?)<\\/w:ins>`, "g"), "$1")
  .replace(new RegExp(`<w:rPrChange\\b${by(author)}[^>]*>[\\s\\S]*?<\\/w:rPrChange>`, "g"), "");

const rejectAll = (xml, author) => xml
  .replace(new RegExp(`<w:ins\\b${by(author)}[^>]*>[\\s\\S]*?<\\/w:ins>`, "g"), "")
  .replace(new RegExp(`<w:del\\b${by(author)}[^>]*>([\\s\\S]*?)<\\/w:del>`, "g"), (all, inner) => inner.replace(/<(\/?)w:delText/g, "<$1w:t"))
  .replace(new RegExp(`<w:rPr>((?:(?!<\\/w:rPr>)[\\s\\S])*?)<w:rPrChange\\b${by(author)}[^>]*><w:rPr>([\\s\\S]*?)<\\/w:rPr><\\/w:rPrChange><\\/w:rPr>`, "g"), "<w:rPr>$2</w:rPr>");

module.exports = { acceptAll, rejectAll };

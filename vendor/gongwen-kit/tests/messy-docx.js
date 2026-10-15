"use strict";
/**
 * messy-docx.js —— 造一份「手写乱稿」，模仿中文版 Word 里直接敲出来的文件：
 * 标题样式 ID 是 "1"／"2"（名字 heading 1／heading 2），正文宋体小四、1.5 倍行距、
 * 版心是 Word 默认的 2.54／3.17cm，表格没声明表头行；混着各类体例错误。
 * 另有几样真实稿里见过的结构：红色段落样式做的红头、居中的文本框、只有默认页眉的节、
 * 页面设置修订（sectPrChange 里嵌着旧 sectPr，外层没写页边距）。
 * tests/fix.js 用它测修复工具；也可以单独跑：node tests/messy-docx.js 输出.docx
 */
const fs = require("fs");
const JSZip = require("jszip");

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"';
const SONG = '<w:rFonts w:ascii="宋体" w:eastAsia="宋体" w:hAnsi="宋体"/>';
const run = (t, extra = "") => `<w:r><w:rPr>${SONG}${extra}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (runs, ppr = "") => `<w:p><w:pPr>${ppr}<w:spacing w:line="360" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
const cell = (t) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p>${run(t)}</w:p></w:tc>`;
const row = (cells) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;

// 段落文本（不含超链接、斜体等结构）——测试用来核对「全部拒绝 = 原文」
const BODY = [
  // 红头的红色来自段落样式，run 上没写颜色
  para(run("××市人民政府办公室"), '<w:pStyle w:val="RedHead"/><w:jc w:val="center"/>'),
  // 居中的文本框（不是标题）
  `<w:p><w:r><w:pict><v:shape style="width:100pt;height:30pt"><v:textbox><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run("内部资料")}</w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`,
  para(run("××市发展和改革委员会文件", '<w:color w:val="FF0000"/><w:b/>'), '<w:jc w:val="center"/>'),
  para(run("×发改【2026】第012号"), '<w:jc w:val="center"/>'),
  para(run("关于做好2026年度项目申报工作的通知", "<w:b/>"), '<w:jc w:val="center"/>'),
  para(run("各县(市、区)发展改革局:")),
  para(run("为做好项目申报,现将有关事项通知如下.")),
  para(run("一、申报范围"), '<w:pStyle w:val="1"/>'),
  para(run("本次申报重点支持以下三点:一是先进制造,二是数字经济.")),
  para(run("二、工作要求"), '<w:pStyle w:val="1"/>'),
  para(run("各地要按要求筹画项目,于2026年05月08日前报送.")
    + `<w:hyperlink r:id="rIdLink">${run("申报系统")}</w:hyperlink>`
    + run("的填报说明另行印发(详见附件).")),
  para(run("请注意: 项目投资额以万元计,储能项目容量写作100kWh,") + run("不得使用斜体", "<w:i/>") + run("。")),
  `<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>`
    + row(["地区", "项目数", "投资额"]) + row(["甲县", "3", "1200"]) + row(["乙县", "2", "800"]) + row(["合计", "5", "2100"]) + "</w:tbl>",
  // 真实稿里见过：段落属性里嵌着修订前的旧属性，又带着别人的修订
  `<w:p><w:pPr><w:ind w:firstLine="420"/><w:pPrChange w:id="900" w:author="审核人" w:date="2025-06-20T00:00:00Z"><w:pPr><w:pStyle w:val="a"/></w:pPr></w:pPrChange></w:pPr>`
    + run("分包专业:") + `<w:del w:id="901" w:author="审核人" w:date="2025-06-20T00:00:00Z"><w:r><w:delText xml:space="preserve"> </w:delText></w:r></w:del>`
    + `<w:ins w:id="902" w:author="审核人" w:date="2025-06-20T00:00:00Z">${run("装饰")}</w:ins>` + run("工程") + "</w:p>",
  para(run("××市发展和改革委员会"), '<w:jc w:val="right"/>'),
  para(run("二〇二六年十月十三日"), '<w:jc w:val="right"/>'),
];

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${BODY.join("")}`
  + `<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:pgSz w:w="11906" w:h="16838"/><w:cols w:space="425"/><w:docGrid w:type="lines" w:linePitch="312"/>`
  + `<w:sectPrChange w:id="903" w:author="排版人" w:date="2025-06-20T00:00:00Z"><w:sectPr><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:sectPrChange></w:sectPr></w:body></w:document>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>`
  + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/><w:kern w:val="2"/><w:sz w:val="21"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>`
  + `<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr></w:style>`
  + `<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:next w:val="a"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="340" w:after="330" w:line="578" w:lineRule="auto"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:kern w:val="44"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>`
  + `<w:style w:type="paragraph" w:customStyle="1" w:styleId="RedHead"><w:name w:val="红头"/><w:basedOn w:val="a"/><w:rPr><w:color w:val="FF0000"/><w:sz w:val="72"/></w:rPr></w:style>`
  + `<w:style w:type="character" w:default="1" w:styleId="a0"><w:name w:val="Default Paragraph Font"/></w:style>`
  + `</w:styles>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W}><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`
  + `<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`
  + `<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/" TargetMode="External"/>`
  + `</Relationships>`;

const TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
  + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
  + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
  + `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>`
  + `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`
  + `</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

async function build(out) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", DOCUMENT);
  zip.file("word/styles.xml", STYLES);
  zip.file("word/settings.xml", SETTINGS);
  zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}><w:p>${run("内部资料　注意保存")}</w:p></w:hdr>`);
  zip.file("word/_rels/document.xml.rels", RELS);
  fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

if (require.main === module) build(process.argv[2] || "messy.docx");
module.exports = { build };

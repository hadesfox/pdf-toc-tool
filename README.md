# PDF 书签生成器

为没有目录的 PDF 自动生成可点击书签。纯浏览器端处理，文件不上传服务器。

## 功能

- 🔍 自动识别目录页（支持文字版和扫描版 PDF）
- 📝 OCR 文字识别（中文+英文，基于 Tesseract.js）
- ✏️ 书签可编辑（标题、层级、页码）
- 📐 自动计算页码偏移
- 🔒 隐私零上传（所有处理在浏览器完成）

## 技术栈

- [pdf.js](https://mozilla.github.io/pdf.js/) — PDF 渲染与文字提取
- [tesseract.js](https://tesseract.projectnaptha.com/) — 浏览器端 OCR
- [pdf-lib](https://pdf-lib.js.org/) — PDF 书签写入

## 使用方法

1. 打开网页
2. 拖入 PDF 文件
3. 等待自动识别完成
4. 检查/编辑书签条目
5. 调整页码偏移（如需要）
6. 点击「生成 PDF」下载

## 工作原理

```
PDF → 渲染前20页 → 检测目录页(启发式评分)
                        ↓
              OCR / 文字提取 → 正则解析(标题+页码)
                        ↓
              自动计算偏移量 → 用户确认 → 写入书签
```

## License

MIT

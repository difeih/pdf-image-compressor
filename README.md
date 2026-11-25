# PDF 内部图像精准压缩工具 (PDF Lossless-Structure Image Compressor)

纯前端运行的 PDF 内部图像精准压缩工具，支持直接部署至 GitHub Pages。

🌐 **在线体验**：[https://difeih.github.io/pdf-image-compressor/](https://difeih.github.io/pdf-image-compressor/)

---

## 核心设计原则

严禁将 PDF 页面整体渲染为 Canvas 后再重新生成图片 PDF。传统做法虽然简单，但会导致文字变位图、无法选中复制搜索、矢量公式与排版模糊失真。

本项目直接解析 PDF 底层对象树，仅对内嵌的图像流进行精准降采样与重新编码，完全保留原文档的：
- 矢量文本图层与可选中复制特性
- LaTeX 数学公式与矢量线条
- 书签目录、大纲层级与超链接
- 页面排版尺寸与注释结构

---

## 技术实现细节

1. **对象遍历与过滤**：使用 `pdf-lib` 加载文档并遍历 `pdfDoc.context.enumerateIndirectObjects()`，筛选 `Subtype === /Image` 的 `PDFRawStream` 对象。自动跳过带透明遮罩（`/SMask`、`/Mask`）、图像遮罩（`/ImageMask`）及特殊色彩空间（如 `/Indexed`、`/DeviceCMYK`、`/ICCBased`）的复杂图像，避免色彩异常。
2. **像素流解码**：
   - 对 `/DCTDecode`（JPEG）流通过 `Blob` + `createImageBitmap` 异步解码；
   - 对 `/FlateDecode` 流通过 `pako.inflate` 内存解压，将 `/DeviceRGB` 或 `/DeviceGray` 原始像素填充至 `ImageData`。
3. **分辨率降采样与可选滤波**：
   - 根据用户设定的最大边长阈值（2400px / 1800px / 1200px）等比缩放；
   - 提供轻度低通滤波选项（`ctx.filter = 'blur(0.4px)'`），减少高频扫描噪点，提升 DCT 编码效率。
4. **安全替换策略**：
   - 重新编码为 JPEG 流后，比对新旧字节大小。**仅当新数据严格小于原流时替换**，若压缩后体积增大则完整保留原图像流。
   - 替换时规范化更新字典属性（`Filter = /DCTDecode`、`ColorSpace = /DeviceRGB`、`Width`、`Height`、`Length` 并移除失效的 `DecodeParms`）。
5. **对象流压缩**：导出时启用 `pdfDoc.save({ useObjectStreams: true })`，压缩交叉引用表与元数据流，进一步缩减体积。

---

## 技术栈

- **构建与框架**：Vite 6 + React 19 + TypeScript + Tailwind CSS v4
- **PDF 与流处理**：`pdf-lib` + `pako`（纯本地依赖，无任何外部 CDN 脚本）
- **图标**：`lucide-react`

---

## 本地开发与构建

```bash
# 安装依赖
npm install

# 启动本地开发服务
npm run dev

# 构建生产版本（产物输出至 dist/）
npm run build
```

---

## 部署说明

`vite.config.ts` 已配置 `base: './'`，构建产物为全相对路径静态文件，推送到 GitHub 仓库的 `main` 分支后将由 GitHub Actions 自动构建并发布至 GitHub Pages。

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import pako from 'pako';
import {
  canvasToBlobBytes,
  processImageSource,
  type ImageProcessOptions,
} from './imageProcessor';

export type CompressionOptions = ImageProcessOptions;

export interface CompressionResult {
  compressedBytes: Uint8Array;
  originalSize: number;
  compressedSize: number;
  reductionPercent: number;
  totalImages: number;
  optimizedImages: number;
  skippedImages: number;
  totalImageBytesBefore: number;
  totalImageBytesAfter: number;
  skipReasons: Record<string, number>;
}

export interface PreviewImageEntry {
  index: number;
  refKey: string;
  width: number;
  height: number;
  originalBytes: number;
  ref: PDFRef;
  stream: PDFRawStream;
  cachedCanvas?: HTMLCanvasElement;
  cachedOriginalUrl?: string;
}

export interface PdfImageSession {
  totalImages: number;
  compressibleImages: PreviewImageEntry[];
  skipReasons: Record<string, number>;
  dispose: () => void;
}

export interface PreviewRenderResult {
  originalUrl: string;
  processedUrl: string;
  originalBytes: number;
  processedBytes: number;
  srcWidth: number;
  srcHeight: number;
  targetWidth: number;
  targetHeight: number;
}

type ResolvedColorSpace =
  | { kind: 'rgb' }
  | { kind: 'gray' }
  | { kind: 'indexed'; palette: Uint8Array; paletteChannels: 1 | 3 }
  | { kind: 'unsupported'; label: string };

function addSkipReason(reasons: Record<string, number>, reason: string) {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function resolveNumber(dict: PDFDict, key: string): number | null {
  const val = dict.lookup(PDFName.of(key));
  if (val instanceof PDFNumber) {
    return val.asNumber();
  }
  return null;
}

function resolveFilters(dict: PDFDict): PDFName[] | 'UNSUPPORTED' {
  const raw = dict.lookup(PDFName.of('Filter'));
  if (!raw) return [];
  if (raw instanceof PDFName) return [raw];
  if (raw instanceof PDFArray) {
    const list: PDFName[] = [];
    for (let i = 0; i < raw.size(); i++) {
      const item = raw.lookup(i);
      if (!(item instanceof PDFName)) return 'UNSUPPORTED';
      list.push(item);
    }
    return list;
  }
  return 'UNSUPPORTED';
}

function resolveDecodeParms(dict: PDFDict): PDFDict | null {
  const raw = dict.lookup(PDFName.of('DecodeParms'));
  if (!raw) return null;
  if (raw instanceof PDFDict) return raw;
  if (raw instanceof PDFArray && raw.size() > 0) {
    const first = raw.lookup(0);
    if (first instanceof PDFDict) return first;
  }
  return null;
}

function resolveColorSpace(
  rawCs: unknown,
  context: PDFDocument['context']
): ResolvedColorSpace {
  if (!rawCs) {
    return { kind: 'unsupported', label: '未知' };
  }

  if (rawCs instanceof PDFName) {
    if (rawCs === PDFName.of('DeviceRGB') || rawCs === PDFName.of('CalRGB')) {
      return { kind: 'rgb' };
    }
    if (rawCs === PDFName.of('DeviceGray') || rawCs === PDFName.of('CalGray')) {
      return { kind: 'gray' };
    }
    return { kind: 'unsupported', label: rawCs.asString() };
  }

  if (rawCs instanceof PDFArray && rawCs.size() > 0) {
    const csType = rawCs.lookup(0);
    if (!(csType instanceof PDFName)) {
      return { kind: 'unsupported', label: 'Array' };
    }

    if (csType === PDFName.of('CalRGB')) return { kind: 'rgb' };
    if (csType === PDFName.of('CalGray')) return { kind: 'gray' };

    if (csType === PDFName.of('ICCBased') && rawCs.size() >= 2) {
      const iccStream = rawCs.lookup(1);
      if (iccStream instanceof PDFRawStream) {
        const n = resolveNumber(iccStream.dict, 'N');
        if (n === 3) return { kind: 'rgb' };
        if (n === 1) return { kind: 'gray' };
        return { kind: 'unsupported', label: `ICCBased(N=${n ?? '?'})` };
      }
      return { kind: 'unsupported', label: 'ICCBased' };
    }

    if (csType === PDFName.of('Indexed') && rawCs.size() >= 4) {
      const baseCs = resolveColorSpace(rawCs.lookup(1), context);
      if (baseCs.kind !== 'rgb' && baseCs.kind !== 'gray') {
        return {
          kind: 'unsupported',
          label: `Indexed(${baseCs.kind === 'unsupported' ? baseCs.label : baseCs.kind})`,
        };
      }
      const lookupObj = rawCs.lookup(3);
      let palette: Uint8Array | null = null;
      if (lookupObj instanceof PDFHexString || lookupObj instanceof PDFString) {
        palette = lookupObj.asBytes();
      } else if (lookupObj instanceof PDFRawStream) {
        const filters = resolveFilters(lookupObj.dict);
        if (
          filters !== 'UNSUPPORTED' &&
          filters.length === 1 &&
          filters[0] === PDFName.of('FlateDecode')
        ) {
          palette = pako.inflate(lookupObj.contents);
        } else if (filters !== 'UNSUPPORTED' && filters.length === 0) {
          palette = lookupObj.contents;
        }
      }
      if (!palette) {
        return { kind: 'unsupported', label: 'Indexed(调色板读取失败)' };
      }
      return {
        kind: 'indexed',
        palette,
        paletteChannels: baseCs.kind === 'rgb' ? 3 : 1,
      };
    }

    return { kind: 'unsupported', label: csType.asString() };
  }

  return { kind: 'unsupported', label: '未知对象' };
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unpredictData(
  data: Uint8Array,
  predictor: number,
  columns: number,
  colors: number,
  bpc: number
): Uint8Array | null {
  if (predictor <= 1) return data;

  if (predictor === 2) {
    if (bpc !== 8) return null;
    const rowBytes = columns * colors;
    if (data.length < rowBytes) return null;
    const rows = Math.floor(data.length / rowBytes);
    const out = new Uint8Array(rows * rowBytes);
    for (let r = 0; r < rows; r++) {
      const offset = r * rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= colors ? out[offset + i - colors] : 0;
        out[offset + i] = (data[offset + i] + left) & 0xff;
      }
    }
    return out;
  }

  if (predictor >= 10 && predictor <= 15) {
    const rowBytes = Math.ceil((columns * colors * bpc) / 8);
    const stride = rowBytes + 1;
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rows = Math.floor(data.length / stride);
    if (rows <= 0) return null;

    const out = new Uint8Array(rows * rowBytes);
    for (let r = 0; r < rows; r++) {
      const srcOffset = r * stride;
      const dstOffset = r * rowBytes;
      const filterType = data[srcOffset];

      for (let i = 0; i < rowBytes; i++) {
        const raw = data[srcOffset + 1 + i];
        const a = i >= bpp ? out[dstOffset + i - bpp] : 0;
        const b = r > 0 ? out[dstOffset - rowBytes + i] : 0;
        const c = r > 0 && i >= bpp ? out[dstOffset - rowBytes + i - bpp] : 0;

        let recon: number;
        switch (filterType) {
          case 0:
            recon = raw;
            break;
          case 1:
            recon = raw + a;
            break;
          case 2:
            recon = raw + b;
            break;
          case 3:
            recon = raw + ((a + b) >> 1);
            break;
          case 4:
            recon = raw + paethPredictor(a, b, c);
            break;
          default:
            return null;
        }
        out[dstOffset + i] = recon & 0xff;
      }
    }
    return out;
  }

  return null;
}

function pixelsToCanvas(
  pixels: Uint8Array,
  width: number,
  height: number,
  cs: Extract<ResolvedColorSpace, { kind: 'rgb' | 'gray' | 'indexed' }>
): HTMLCanvasElement | null {
  const pixelCount = width * height;
  const srcChannels = cs.kind === 'rgb' ? 3 : 1;
  if (pixels.length < pixelCount * srcChannels) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const imageData = ctx.createImageData(width, height);
  const rgba = imageData.data;

  if (cs.kind === 'rgb') {
    for (let i = 0, src = 0, dst = 0; i < pixelCount; i++, src += 3, dst += 4) {
      rgba[dst] = pixels[src];
      rgba[dst + 1] = pixels[src + 1];
      rgba[dst + 2] = pixels[src + 2];
      rgba[dst + 3] = 255;
    }
  } else if (cs.kind === 'gray') {
    for (let i = 0, dst = 0; i < pixelCount; i++, dst += 4) {
      const v = pixels[i];
      rgba[dst] = v;
      rgba[dst + 1] = v;
      rgba[dst + 2] = v;
      rgba[dst + 3] = 255;
    }
  } else {
    const { palette, paletteChannels } = cs;
    for (let i = 0, dst = 0; i < pixelCount; i++, dst += 4) {
      const idx = pixels[i];
      const pOffset = idx * paletteChannels;
      if (paletteChannels === 3) {
        rgba[dst] = palette[pOffset] ?? 0;
        rgba[dst + 1] = palette[pOffset + 1] ?? 0;
        rgba[dst + 2] = palette[pOffset + 2] ?? 0;
      } else {
        const v = palette[pOffset] ?? 0;
        rgba[dst] = v;
        rgba[dst + 1] = v;
        rgba[dst + 2] = v;
      }
      rgba[dst + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

type DecodedPdfImageResult =
  | { canvas: HTMLCanvasElement; width: number; height: number }
  | { skipReason: string };

function validateImageEntry(
  ref: PDFRef,
  obj: PDFRawStream,
  maskRefKeys: Set<string>,
  context: PDFDocument['context']
):
  | {
      ok: true;
      width: number;
      height: number;
      cs: Extract<ResolvedColorSpace, { kind: 'rgb' | 'gray' | 'indexed' }>;
      isDct: boolean;
      isFlateDct: boolean;
      isFlate: boolean;
    }
  | { ok: false; skipReason: string } {
  const dict = obj.dict;

  if (maskRefKeys.has(ref.toString())) {
    return { ok: false, skipReason: '透明遮罩流（保持原样）' };
  }
  const imageMask = dict.lookup(PDFName.of('ImageMask'));
  if (imageMask instanceof PDFBool && imageMask.asBoolean()) {
    return { ok: false, skipReason: '单色遮罩（保持原样）' };
  }
  if (dict.has(PDFName.of('Mask'))) {
    return { ok: false, skipReason: '颜色键遮罩（保持原样）' };
  }

  const bpc = resolveNumber(dict, 'BitsPerComponent');
  if (bpc !== null && bpc !== 8) {
    return { ok: false, skipReason: `非 8-bit 通道 (${bpc}bit)` };
  }

  const width = resolveNumber(dict, 'Width');
  const height = resolveNumber(dict, 'Height');
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { ok: false, skipReason: '缺失宽高信息' };
  }

  const cs = resolveColorSpace(dict.lookup(PDFName.of('ColorSpace')), context);
  if (cs.kind === 'unsupported') {
    return { ok: false, skipReason: `色彩空间不支持 (${cs.label})` };
  }

  const filters = resolveFilters(dict);
  if (filters === 'UNSUPPORTED') {
    return { ok: false, skipReason: '滤镜链不支持' };
  }

  const isDct = filters.length === 1 && filters[0] === PDFName.of('DCTDecode');
  const isFlateDct =
    filters.length === 2 &&
    filters[0] === PDFName.of('FlateDecode') &&
    filters[1] === PDFName.of('DCTDecode');
  const isFlate =
    filters.length === 1 && filters[0] === PDFName.of('FlateDecode');
  const isUncompressed = filters.length === 0;

  if (!isDct && !isFlateDct && !isFlate && !isUncompressed) {
    const fLabel = filters.map((f) => f.asString()).join('+');
    return { ok: false, skipReason: `编码滤镜不支持 (${fLabel})` };
  }

  return { ok: true, width, height, cs, isDct, isFlateDct, isFlate };
}

async function decodePdfImageEntry(
  ref: PDFRef,
  obj: PDFRawStream,
  maskRefKeys: Set<string>,
  context: PDFDocument['context']
): Promise<DecodedPdfImageResult> {
  const check = validateImageEntry(ref, obj, maskRefKeys, context);
  if (!check.ok) {
    return { skipReason: check.skipReason };
  }

  const { width, height, cs, isDct, isFlateDct, isFlate } = check;
  const dict = obj.dict;

  if (isDct || isFlateDct) {
    const jpegBytes = isFlateDct ? pako.inflate(obj.contents) : obj.contents;
    const jpegBlob = new Blob([new Uint8Array(jpegBytes)], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(jpegBlob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        canvas.width = 0;
        canvas.height = 0;
        return { skipReason: 'Canvas 上下文创建失败' };
      }
      ctx.drawImage(bitmap, 0, 0);
      return { canvas, width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }

  let rawPixels: Uint8Array | null = isFlate
    ? pako.inflate(obj.contents)
    : obj.contents;

  const decodeParms = resolveDecodeParms(dict);
  if (decodeParms) {
    const predictor = resolveNumber(decodeParms, 'Predictor') ?? 1;
    if (predictor > 1) {
      const columns = resolveNumber(decodeParms, 'Columns') ?? width;
      const colors =
        resolveNumber(decodeParms, 'Colors') ?? (cs.kind === 'rgb' ? 3 : 1);
      const parmBpc = resolveNumber(decodeParms, 'BitsPerComponent') ?? 8;
      rawPixels = unpredictData(rawPixels, predictor, columns, colors, parmBpc);
      if (!rawPixels) {
        return { skipReason: `Predictor(${predictor}) 不支持` };
      }
    }
  }

  const canvas = pixelsToCanvas(rawPixels, width, height, cs);
  if (!canvas) {
    return { skipReason: '像素数据长度不匹配' };
  }
  return { canvas, width, height };
}

function collectMaskRefKeys(imageEntries: [PDFRef, PDFRawStream][]): Set<string> {
  const maskRefKeys = new Set<string>();
  for (const [, obj] of imageEntries) {
    const sMask = obj.dict.get(PDFName.of('SMask'));
    if (sMask instanceof PDFRef) maskRefKeys.add(sMask.toString());
    const mask = obj.dict.get(PDFName.of('Mask'));
    if (mask instanceof PDFRef) maskRefKeys.add(mask.toString());
  }
  return maskRefKeys;
}

async function loadPdfSafe(fileBuffer: ArrayBuffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(fileBuffer.slice(0), { ignoreEncryption: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('encrypt')) {
      throw new Error('该 PDF 文档受密码或加密保护，请先移除加密后再处理。');
    }
    throw new Error(`无法解析 PDF 文件：${msg}`);
  }
}

export async function inspectPdfImages(
  fileBuffer: ArrayBuffer
): Promise<PdfImageSession> {
  const pdfDoc = await loadPdfSafe(fileBuffer);
  const imageEntries = pdfDoc.context
    .enumerateIndirectObjects()
    .filter((entry): entry is [PDFRef, PDFRawStream] => {
      const [, obj] = entry;
      if (!(obj instanceof PDFRawStream)) return false;
      return obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image');
    });

  const maskRefKeys = collectMaskRefKeys(imageEntries);
  const skipReasons: Record<string, number> = {};
  const compressibleImages: PreviewImageEntry[] = [];

  for (const [ref, stream] of imageEntries) {
    const check = validateImageEntry(ref, stream, maskRefKeys, pdfDoc.context);
    if (!check.ok) {
      addSkipReason(skipReasons, check.skipReason);
      continue;
    }
    compressibleImages.push({
      index: compressibleImages.length,
      refKey: ref.toString(),
      width: check.width,
      height: check.height,
      originalBytes: stream.contents.length,
      ref,
      stream,
    });
  }

  return {
    totalImages: imageEntries.length,
    compressibleImages,
    skipReasons,
    dispose: () => {
      for (const item of compressibleImages) {
        if (item.cachedCanvas) {
          item.cachedCanvas.width = 0;
          item.cachedCanvas.height = 0;
          item.cachedCanvas = undefined;
        }
        if (item.cachedOriginalUrl) {
          URL.revokeObjectURL(item.cachedOriginalUrl);
          item.cachedOriginalUrl = undefined;
        }
      }
    },
  };
}

export async function renderPreviewForIndex(
  session: PdfImageSession,
  idx: number,
  options: ImageProcessOptions
): Promise<PreviewRenderResult> {
  const entry = session.compressibleImages[idx];
  if (!entry) {
    throw new Error('预览图像索引无效');
  }

  // 解码并缓存原图 Canvas 与原图 Blob URL，滑块调整时无需重新解压 PDF 流
  if (!entry.cachedCanvas) {
    const decoded = await decodePdfImageEntry(
      entry.ref,
      entry.stream,
      new Set<string>(),
      entry.stream.dict.context
    );
    if ('skipReason' in decoded) {
      throw new Error(`图像解码失败：${decoded.skipReason}`);
    }
    entry.cachedCanvas = decoded.canvas;
    entry.width = decoded.width;
    entry.height = decoded.height;
  }

  if (!entry.cachedOriginalUrl) {
    const origPngBytes = await canvasToBlobBytes(entry.cachedCanvas, 'image/png');
    const origBlob = new Blob([new Uint8Array(origPngBytes)], { type: 'image/png' });
    entry.cachedOriginalUrl = URL.createObjectURL(origBlob);
  }

  const processed = await processImageSource(
    entry.cachedCanvas,
    entry.width,
    entry.height,
    options
  );
  const procBlob = new Blob([new Uint8Array(processed.jpegBytes)], {
    type: 'image/jpeg',
  });
  const processedUrl = URL.createObjectURL(procBlob);

  return {
    originalUrl: entry.cachedOriginalUrl,
    processedUrl,
    originalBytes: entry.originalBytes,
    processedBytes: processed.jpegBytes.length,
    srcWidth: entry.width,
    srcHeight: entry.height,
    targetWidth: processed.targetWidth,
    targetHeight: processed.targetHeight,
  };
}

export async function compressPdfImages(
  fileBuffer: ArrayBuffer,
  options: CompressionOptions,
  onProgress?: (current: number, total: number) => void
): Promise<CompressionResult> {
  const originalSize = fileBuffer.byteLength;
  const pdfDoc = await loadPdfSafe(fileBuffer);

  const imageEntries = pdfDoc.context
    .enumerateIndirectObjects()
    .filter((entry): entry is [PDFRef, PDFRawStream] => {
      const [, obj] = entry;
      if (!(obj instanceof PDFRawStream)) return false;
      return obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image');
    });

  const maskRefKeys = collectMaskRefKeys(imageEntries);
  const totalImages = imageEntries.length;
  let optimizedImages = 0;
  let skippedImages = 0;
  let totalImageBytesBefore = 0;
  let totalImageBytesAfter = 0;
  const skipReasons: Record<string, number> = {};

  for (let idx = 0; idx < totalImages; idx++) {
    const [ref, obj] = imageEntries[idx];
    onProgress?.(idx + 1, totalImages);

    const origBytesLen = obj.contents.length;
    totalImageBytesBefore += origBytesLen;
    let replaced = false;

    try {
      const decoded = await decodePdfImageEntry(
        ref,
        obj,
        maskRefKeys,
        pdfDoc.context
      );

      if ('skipReason' in decoded) {
        skippedImages++;
        addSkipReason(skipReasons, decoded.skipReason);
        continue;
      }

      try {
        const { jpegBytes, targetWidth, targetHeight } = await processImageSource(
          decoded.canvas,
          decoded.width,
          decoded.height,
          options
        );

        // 仅当新流字节严格小于原流字节时替换
        if (jpegBytes.length < origBytesLen) {
          const dict = obj.dict;
          dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
          dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
          dict.set(PDFName.of('Width'), PDFNumber.of(targetWidth));
          dict.set(PDFName.of('Height'), PDFNumber.of(targetHeight));
          dict.set(PDFName.of('Length'), PDFNumber.of(jpegBytes.length));
          dict.delete(PDFName.of('DecodeParms'));
          dict.delete(PDFName.of('Decode'));

          pdfDoc.context.assign(ref, PDFRawStream.of(dict, jpegBytes));
          optimizedImages++;
          totalImageBytesAfter += jpegBytes.length;
          replaced = true;
        } else {
          skippedImages++;
          addSkipReason(skipReasons, '压缩后体积未变小');
        }
      } finally {
        decoded.canvas.width = 0;
        decoded.canvas.height = 0;
      }
    } catch {
      skippedImages++;
      addSkipReason(skipReasons, '解码异常');
    } finally {
      if (!replaced) {
        totalImageBytesAfter += origBytesLen;
      }
    }
  }

  const compressedBytes = await pdfDoc.save({ useObjectStreams: true });
  const compressedSize = compressedBytes.byteLength;
  const reductionPercent =
    originalSize > 0 ? ((compressedSize - originalSize) / originalSize) * 100 : 0;

  return {
    compressedBytes,
    originalSize,
    compressedSize,
    reductionPercent,
    totalImages,
    optimizedImages,
    skippedImages,
    totalImageBytesBefore,
    totalImageBytesAfter,
    skipReasons,
  };
}

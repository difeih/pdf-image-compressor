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

export interface CompressionOptions {
  quality: number;
  maxDimension: number;
  enableLowPassFilter: boolean;
}

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
        if (filters !== 'UNSUPPORTED' && filters.length === 1 && filters[0] === PDFName.of('FlateDecode')) {
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

  // TIFF Predictor 2 (Horizontal differencing, 8-bit)
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

  // PNG Predictors (10-15)
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

function canvasToJpegBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error('Canvas JPEG 编码失败'));
          return;
        }
        try {
          const buf = await blob.arrayBuffer();
          resolve(new Uint8Array(buf));
        } catch (err) {
          reject(err);
        }
      },
      'image/jpeg',
      quality
    );
  });
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

function computeTargetDimensions(
  width: number,
  height: number,
  maxDimension: number
): { targetWidth: number; targetHeight: number } {
  const maxSide = Math.max(width, height);
  if (maxSide <= maxDimension) {
    return { targetWidth: width, targetHeight: height };
  }
  const scale = maxDimension / maxSide;
  return {
    targetWidth: Math.max(1, Math.round(width * scale)),
    targetHeight: Math.max(1, Math.round(height * scale)),
  };
}

export async function compressPdfImages(
  fileBuffer: ArrayBuffer,
  options: CompressionOptions,
  onProgress?: (current: number, total: number) => void
): Promise<CompressionResult> {
  const originalSize = fileBuffer.byteLength;

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(fileBuffer.slice(0), { ignoreEncryption: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('encrypt')) {
      throw new Error('该 PDF 文档受密码或加密保护，请先移除加密后再处理。');
    }
    throw new Error(`无法解析 PDF 文件：${msg}`);
  }

  const imageEntries = pdfDoc.context
    .enumerateIndirectObjects()
    .filter(([, obj]) => {
      if (!(obj instanceof PDFRawStream)) return false;
      return obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image');
    });

  // 预先收集所有被 /SMask 或 /Mask 引用的遮罩对象，避免将 Alpha 通道误转为彩色 JPEG
  const maskRefKeys = new Set<string>();
  for (const [, obj] of imageEntries) {
    if (!(obj instanceof PDFRawStream)) continue;
    const sMask = obj.dict.get(PDFName.of('SMask'));
    if (sMask instanceof PDFRef) maskRefKeys.add(sMask.toString());
    const mask = obj.dict.get(PDFName.of('Mask'));
    if (mask instanceof PDFRef) maskRefKeys.add(mask.toString());
  }

  const totalImages = imageEntries.length;
  let optimizedImages = 0;
  let skippedImages = 0;
  let totalImageBytesBefore = 0;
  let totalImageBytesAfter = 0;
  const skipReasons: Record<string, number> = {};

  for (let idx = 0; idx < totalImages; idx++) {
    const [ref, obj] = imageEntries[idx];
    onProgress?.(idx + 1, totalImages);

    if (!(obj instanceof PDFRawStream)) {
      skippedImages++;
      addSkipReason(skipReasons, '非流对象');
      continue;
    }

    const origBytesLen = obj.contents.length;
    totalImageBytesBefore += origBytesLen;

    const dict = obj.dict;
    let replaced = false;

    try {
      // 跳过本身作为透明遮罩（SMask/Mask）或单色图像遮罩（ImageMask）的流
      if (maskRefKeys.has(ref.toString())) {
        skippedImages++;
        addSkipReason(skipReasons, '透明遮罩流（保持原样）');
        continue;
      }
      const imageMask = dict.lookup(PDFName.of('ImageMask'));
      if (imageMask instanceof PDFBool && imageMask.asBoolean()) {
        skippedImages++;
        addSkipReason(skipReasons, '单色遮罩（保持原样）');
        continue;
      }
      if (dict.has(PDFName.of('Mask'))) {
        skippedImages++;
        addSkipReason(skipReasons, '颜色键遮罩（保持原样）');
        continue;
      }

      const bpc = resolveNumber(dict, 'BitsPerComponent');
      if (bpc !== null && bpc !== 8) {
        skippedImages++;
        addSkipReason(skipReasons, `非 8-bit 通道 (${bpc}bit)`);
        continue;
      }

      const width = resolveNumber(dict, 'Width');
      const height = resolveNumber(dict, 'Height');
      if (width === null || height === null || width <= 0 || height <= 0) {
        skippedImages++;
        addSkipReason(skipReasons, '缺失宽高信息');
        continue;
      }

      const cs = resolveColorSpace(dict.lookup(PDFName.of('ColorSpace')), pdfDoc.context);
      if (cs.kind === 'unsupported') {
        skippedImages++;
        addSkipReason(skipReasons, `色彩空间不支持 (${cs.label})`);
        continue;
      }

      const filters = resolveFilters(dict);
      if (filters === 'UNSUPPORTED') {
        skippedImages++;
        addSkipReason(skipReasons, '滤镜链不支持');
        continue;
      }

      const isDct =
        filters.length === 1 && filters[0] === PDFName.of('DCTDecode');
      const isFlateDct =
        filters.length === 2 &&
        filters[0] === PDFName.of('FlateDecode') &&
        filters[1] === PDFName.of('DCTDecode');
      const isFlate =
        filters.length === 1 && filters[0] === PDFName.of('FlateDecode');
      const isUncompressed = filters.length === 0;

      if (!isDct && !isFlateDct && !isFlate && !isUncompressed) {
        skippedImages++;
        const fLabel = filters.map((f) => f.asString()).join('+');
        addSkipReason(skipReasons, `编码滤镜不支持 (${fLabel})`);
        continue;
      }

      let sourceCanvas: HTMLCanvasElement | null = null;
      let bitmap: ImageBitmap | null = null;

      try {
        if (isDct || isFlateDct) {
          const jpegBytes = isFlateDct ? pako.inflate(obj.contents) : obj.contents;
          const jpegBlob = new Blob([new Uint8Array(jpegBytes)], { type: 'image/jpeg' });
          bitmap = await createImageBitmap(jpegBlob);
        } else {
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
                skippedImages++;
                addSkipReason(skipReasons, `Predictor(${predictor}) 不支持`);
                continue;
              }
            }
          }

          sourceCanvas = pixelsToCanvas(rawPixels, width, height, cs);
          if (!sourceCanvas) {
            skippedImages++;
            addSkipReason(skipReasons, '像素数据长度不匹配');
            continue;
          }
        }

        const srcW = bitmap ? bitmap.width : width;
        const srcH = bitmap ? bitmap.height : height;
        const { targetWidth, targetHeight } = computeTargetDimensions(
          srcW,
          srcH,
          options.maxDimension
        );

        const outCanvas = document.createElement('canvas');
        outCanvas.width = targetWidth;
        outCanvas.height = targetHeight;
        const outCtx = outCanvas.getContext('2d');
        if (!outCtx) {
          skippedImages++;
          addSkipReason(skipReasons, 'Canvas 上下文创建失败');
          continue;
        }

        outCtx.imageSmoothingEnabled = true;
        outCtx.imageSmoothingQuality = 'high';
        if (options.enableLowPassFilter) {
          outCtx.filter = 'blur(0.4px)';
        }

        outCtx.fillStyle = '#ffffff';
        outCtx.fillRect(0, 0, targetWidth, targetHeight);

        if (bitmap) {
          outCtx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        } else if (sourceCanvas) {
          outCtx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
        }

        const newBytes = await canvasToJpegBytes(outCanvas, options.quality);

        // 安全替换策略：仅当新生成的 JPEG 字节长度严格小于原流字节长度时替换
        if (newBytes.length < origBytesLen) {
          dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
          dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
          dict.set(PDFName.of('Width'), PDFNumber.of(targetWidth));
          dict.set(PDFName.of('Height'), PDFNumber.of(targetHeight));
          dict.set(PDFName.of('Length'), PDFNumber.of(newBytes.length));
          dict.delete(PDFName.of('DecodeParms'));
          dict.delete(PDFName.of('Decode'));

          pdfDoc.context.assign(ref, PDFRawStream.of(dict, newBytes));
          optimizedImages++;
          totalImageBytesAfter += newBytes.length;
          replaced = true;
        } else {
          skippedImages++;
          addSkipReason(skipReasons, '压缩后体积未变小');
        }
      } finally {
        bitmap?.close();
        if (sourceCanvas) {
          sourceCanvas.width = 0;
          sourceCanvas.height = 0;
        }
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

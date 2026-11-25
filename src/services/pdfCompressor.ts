import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
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
}

function resolveNumber(dict: PDFDict, key: string): number | null {
  const val = dict.lookup(PDFName.of(key));
  if (val instanceof PDFNumber) {
    return val.asNumber();
  }
  return null;
}

function resolveFilterName(dict: PDFDict): PDFName | null | 'UNSUPPORTED' {
  const raw = dict.lookup(PDFName.of('Filter'));
  if (!raw) return null;
  if (raw instanceof PDFName) return raw;
  if (raw instanceof PDFArray) {
    if (raw.size() === 0) return null;
    if (raw.size() === 1) {
      const first = raw.lookup(0);
      if (first instanceof PDFName) return first;
    }
    return 'UNSUPPORTED';
  }
  return 'UNSUPPORTED';
}

function hasUnsupportedPredictor(dict: PDFDict): boolean {
  const raw = dict.lookup(PDFName.of('DecodeParms'));
  if (!raw) return false;

  const checkDict = (d: PDFDict): boolean => {
    const predictor = resolveNumber(d, 'Predictor');
    return predictor !== null && predictor > 1;
  };

  if (raw instanceof PDFDict) {
    return checkDict(raw);
  }
  if (raw instanceof PDFArray) {
    for (let i = 0; i < raw.size(); i++) {
      const item = raw.lookup(i);
      if (item instanceof PDFDict && checkDict(item)) {
        return true;
      }
    }
  }
  return false;
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

function rawPixelsToCanvas(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 3
): HTMLCanvasElement | null {
  const expectedLength = width * height * channels;
  if (pixels.length < expectedLength) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const imageData = ctx.createImageData(width, height);
  const rgba = imageData.data;
  const pixelCount = width * height;

  if (channels === 3) {
    for (let i = 0, src = 0, dst = 0; i < pixelCount; i++, src += 3, dst += 4) {
      rgba[dst] = pixels[src];
      rgba[dst + 1] = pixels[src + 1];
      rgba[dst + 2] = pixels[src + 2];
      rgba[dst + 3] = 255;
    }
  } else {
    for (let i = 0, dst = 0; i < pixelCount; i++, dst += 4) {
      const v = pixels[i];
      rgba[dst] = v;
      rgba[dst + 1] = v;
      rgba[dst + 2] = v;
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
      return obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image');
    });

  const totalImages = imageEntries.length;
  let optimizedImages = 0;
  let skippedImages = 0;

  for (let idx = 0; idx < totalImages; idx++) {
    const [ref, obj] = imageEntries[idx];
    onProgress?.(idx + 1, totalImages);

    if (!(obj instanceof PDFRawStream)) {
      skippedImages++;
      continue;
    }

    const dict = obj.dict;

    try {
      // 跳过带遮罩或图像遮罩的复杂对象
      if (dict.has(PDFName.of('SMask')) || dict.has(PDFName.of('Mask'))) {
        skippedImages++;
        continue;
      }
      const imageMask = dict.lookup(PDFName.of('ImageMask'));
      if (imageMask instanceof PDFBool && imageMask.asBoolean()) {
        skippedImages++;
        continue;
      }

      // 仅处理 DeviceRGB 与 DeviceGray，跳过 Indexed / CMYK / ICCBased 等特殊色彩空间
      const colorSpace = dict.lookup(PDFName.of('ColorSpace'));
      const isRgb = colorSpace === PDFName.of('DeviceRGB');
      const isGray = colorSpace === PDFName.of('DeviceGray');
      if (!isRgb && !isGray) {
        skippedImages++;
        continue;
      }

      // 仅处理 8-bit 通道深度
      const bpc = resolveNumber(dict, 'BitsPerComponent');
      if (bpc !== null && bpc !== 8) {
        skippedImages++;
        continue;
      }

      const width = resolveNumber(dict, 'Width');
      const height = resolveNumber(dict, 'Height');
      if (width === null || height === null || width <= 0 || height <= 0) {
        skippedImages++;
        continue;
      }

      const filter = resolveFilterName(dict);
      if (filter === 'UNSUPPORTED') {
        skippedImages++;
        continue;
      }

      const isDct = filter === PDFName.of('DCTDecode');
      const isFlate = filter === PDFName.of('FlateDecode');
      const isUncompressed = filter === null;

      if (!isDct && !isFlate && !isUncompressed) {
        skippedImages++;
        continue;
      }

      let sourceCanvas: HTMLCanvasElement | null = null;
      let bitmap: ImageBitmap | null = null;

      try {
        if (isDct) {
          const jpegBlob = new Blob([new Uint8Array(obj.contents)], { type: 'image/jpeg' });
          bitmap = await createImageBitmap(jpegBlob);
        } else {
          if (hasUnsupportedPredictor(dict)) {
            skippedImages++;
            continue;
          }
          const rawPixels = isFlate ? pako.inflate(obj.contents) : obj.contents;
          sourceCanvas = rawPixelsToCanvas(rawPixels, width, height, isRgb ? 3 : 1);
          if (!sourceCanvas) {
            skippedImages++;
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
          continue;
        }

        outCtx.imageSmoothingEnabled = true;
        outCtx.imageSmoothingQuality = 'high';
        if (options.enableLowPassFilter) {
          outCtx.filter = 'blur(0.4px)';
        }

        // 填充白底以防止边缘插值产生异常黑边
        outCtx.fillStyle = '#ffffff';
        outCtx.fillRect(0, 0, targetWidth, targetHeight);

        if (bitmap) {
          outCtx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        } else if (sourceCanvas) {
          outCtx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
        }

        const newBytes = await canvasToJpegBytes(outCanvas, options.quality);

        // 安全替换策略：仅当新生成的 JPEG 字节长度严格小于原流字节长度时替换
        if (newBytes.length < obj.contents.length) {
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
        } else {
          skippedImages++;
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
  };
}

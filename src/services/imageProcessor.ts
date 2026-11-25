export interface ImageProcessOptions {
  quality: number;
  maxDimension: number;
  smartFrequencyCompression: boolean;
  scanStrength: number; // 0..100
  scanGrayscale: boolean;
}

export interface ProcessedImageOutput {
  jpegBytes: Uint8Array;
  targetWidth: number;
  targetHeight: number;
}

export function computeTargetDimensions(
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

export function canvasToBlobBytes(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error(`Canvas ${mimeType} 编码失败`));
          return;
        }
        try {
          const buf = await blob.arrayBuffer();
          resolve(new Uint8Array(buf));
        } catch (err) {
          reject(err);
        }
      },
      mimeType,
      quality
    );
  });
}

function estimateBackgroundData(
  sourceCanvas: HTMLCanvasElement,
  width: number,
  height: number
): Uint8ClampedArray | null {
  const smallW = Math.max(16, Math.round(width / 28));
  const smallH = Math.max(16, Math.round(height / 28));

  const smallCanvas = document.createElement('canvas');
  smallCanvas.width = smallW;
  smallCanvas.height = smallH;
  const smallCtx = smallCanvas.getContext('2d');

  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = width;
  bgCanvas.height = height;
  const bgCtx = bgCanvas.getContext('2d');

  if (!smallCtx || !bgCtx) {
    smallCanvas.width = 0;
    smallCanvas.height = 0;
    bgCanvas.width = 0;
    bgCanvas.height = 0;
    return null;
  }

  try {
    smallCtx.imageSmoothingEnabled = true;
    smallCtx.imageSmoothingQuality = 'high';
    smallCtx.filter = 'blur(2px)';
    smallCtx.drawImage(sourceCanvas, 0, 0, smallW, smallH);

    bgCtx.imageSmoothingEnabled = true;
    bgCtx.imageSmoothingQuality = 'high';
    bgCtx.drawImage(smallCanvas, 0, 0, width, height);

    return bgCtx.getImageData(0, 0, width, height).data;
  } finally {
    smallCanvas.width = 0;
    smallCanvas.height = 0;
    bgCanvas.width = 0;
    bgCanvas.height = 0;
  }
}

function applyScanEnhancement(
  data: Uint8ClampedArray,
  bgData: Uint8ClampedArray,
  scanStrength: number,
  scanGrayscale: boolean
): void {
  const t = Math.max(0, Math.min(1, scanStrength / 100));
  if (t <= 0) return;

  const whitePt = 255 - t * 48;
  const blackPt = t * 85;
  const denom = Math.max(1, whitePt - blackPt);
  const gamma = 1 + t * 0.25;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    const normR = Math.min(255, (r / Math.max(bgData[i], 40)) * 255);
    const normG = Math.min(255, (g / Math.max(bgData[i + 1], 40)) * 255);
    const normB = Math.min(255, (b / Math.max(bgData[i + 2], 40)) * 255);

    const vr = r * (1 - t) + normR * t;
    const vg = g * (1 - t) + normG * t;
    const vb = b * (1 - t) + normB * t;

    const ur = Math.max(0, Math.min(1, (vr - blackPt) / denom));
    const ug = Math.max(0, Math.min(1, (vg - blackPt) / denom));
    const ub = Math.max(0, Math.min(1, (vb - blackPt) / denom));

    r = Math.round(Math.pow(ur, gamma) * 255);
    g = Math.round(Math.pow(ug, gamma) * 255);
    b = Math.round(Math.pow(ub, gamma) * 255);

    if (scanGrayscale) {
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      data[i] = lum;
      data[i + 1] = lum;
      data[i + 2] = lum;
    } else {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
}

/**
 * 8×8 DCT 块对齐的频率感知平滑：
 * 低频平坦区域向块均值收缩以消除纸张/背景噪点并降低编码比特，
 * 高频边缘区域（文字、手写笔迹、线条）完全保留原始锐利像素。
 */
function applySmartFrequencyCompression(
  data: Uint8ClampedArray,
  width: number,
  height: number
): void {
  const lowT = 18;
  const highT = 40;
  const maxSmooth = 0.85;

  for (let by = 0; by < height; by += 8) {
    const blockH = Math.min(8, height - by);
    for (let bx = 0; bx < width; bx += 8) {
      const blockW = Math.min(8, width - bx);
      const count = blockW * blockH;

      let minL = 255;
      let maxL = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;

      for (let dy = 0; dy < blockH; dy++) {
        const rowOffset = ((by + dy) * width + bx) * 4;
        for (let dx = 0; dx < blockW; dx++) {
          const idx = rowOffset + dx * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];

          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum < minL) minL = lum;
          if (lum > maxL) maxL = lum;

          sumR += r;
          sumG += g;
          sumB += b;
        }
      }

      const range = maxL - minL;
      if (range >= highT) {
        // 高频细节区：完全保留原始锐利像素
        continue;
      }

      const smoothFactor =
        range <= lowT
          ? maxSmooth
          : maxSmooth * (1 - (range - lowT) / (highT - lowT));

      const meanR = sumR / count;
      const meanG = sumG / count;
      const meanB = sumB / count;
      const keep = 1 - smoothFactor;

      for (let dy = 0; dy < blockH; dy++) {
        const rowOffset = ((by + dy) * width + bx) * 4;
        for (let dx = 0; dx < blockW; dx++) {
          const idx = rowOffset + dx * 4;
          data[idx] = Math.round(data[idx] * keep + meanR * smoothFactor);
          data[idx + 1] = Math.round(data[idx + 1] * keep + meanG * smoothFactor);
          data[idx + 2] = Math.round(data[idx + 2] * keep + meanB * smoothFactor);
        }
      }
    }
  }
}

export async function processImageSource(
  source: HTMLCanvasElement | ImageBitmap,
  srcW: number,
  srcH: number,
  options: ImageProcessOptions
): Promise<ProcessedImageOutput> {
  const { targetWidth, targetHeight } = computeTargetDimensions(
    srcW,
    srcH,
    options.maxDimension
  );

  const outCanvas = document.createElement('canvas');
  outCanvas.width = targetWidth;
  outCanvas.height = targetHeight;

  try {
    const outCtx = outCanvas.getContext('2d');
    if (!outCtx) {
      throw new Error('Canvas 上下文创建失败');
    }

    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, targetWidth, targetHeight);
    outCtx.drawImage(source, 0, 0, targetWidth, targetHeight);

    const needPixelPass =
      options.scanStrength > 0 || options.smartFrequencyCompression;

    if (needPixelPass) {
      const imageData = outCtx.getImageData(0, 0, targetWidth, targetHeight);

      if (options.scanStrength > 0) {
        const bgData = estimateBackgroundData(outCanvas, targetWidth, targetHeight);
        if (bgData) {
          applyScanEnhancement(
            imageData.data,
            bgData,
            options.scanStrength,
            options.scanGrayscale
          );
        }
      }

      if (options.smartFrequencyCompression) {
        applySmartFrequencyCompression(imageData.data, targetWidth, targetHeight);
      }

      outCtx.putImageData(imageData, 0, 0);
    }

    const jpegBytes = await canvasToBlobBytes(
      outCanvas,
      'image/jpeg',
      options.quality
    );

    return { jpegBytes, targetWidth, targetHeight };
  } finally {
    outCanvas.width = 0;
    outCanvas.height = 0;
  }
}

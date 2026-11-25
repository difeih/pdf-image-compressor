import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Loader2,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import {
  compressPdfImages,
  inspectPdfImages,
  renderPreviewForIndex,
  type CompressionResult,
  type PdfImageSession,
  type PreviewRenderResult,
} from './services/pdfCompressor';

interface PresetOption {
  id: 'light' | 'balanced' | 'extreme';
  label: string;
  quality: number;
  maxDimension: number;
}

const PRESETS: PresetOption[] = [
  {
    id: 'light',
    label: '轻度压缩（画质优先，质量 0.85，最大边 2600px）',
    quality: 0.85,
    maxDimension: 2600,
  },
  {
    id: 'balanced',
    label: '均衡压缩（推荐，质量 0.75，最大边 2000px）',
    quality: 0.75,
    maxDimension: 2000,
  },
  {
    id: 'extreme',
    label: '极限压缩（体积优先，质量 0.58，最大边 1400px）',
    quality: 0.58,
    maxDimension: 1400,
  },
];

type PreviewViewMode = 'split' | 'processed' | 'original';
type PreviewZoomMode = 'fit' | '100' | '200';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [presetId, setPresetId] = useState<PresetOption['id']>('balanced');
  const [smartFrequencyCompression, setSmartFrequencyCompression] = useState(true);
  const [scanStrength, setScanStrength] = useState(0);
  const [scanGrayscale, setScanGrayscale] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CompressionResult | null>(null);

  // 预览状态
  const sessionRef = useRef<PdfImageSession | null>(null);
  const [sessionMeta, setSessionMeta] = useState<{
    totalImages: number;
    compressibleCount: number;
  } | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [viewMode, setViewMode] = useState<PreviewViewMode>('split');
  const [zoomMode, setZoomMode] = useState<PreviewZoomMode>('fit');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<PreviewRenderResult | null>(null);
  const lastProcessedUrlRef = useRef<string | null>(null);

  const activePreset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[1];

  useEffect(() => {
    return () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      if (lastProcessedUrlRef.current) {
        URL.revokeObjectURL(lastProcessedUrlRef.current);
        lastProcessedUrlRef.current = null;
      }
    };
  }, []);

  const handleFileSelect = async (file: File | null | undefined) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMsg('请选择有效的 .pdf 文件。');
      return;
    }

    setSelectedFile(file);
    setResult(null);
    setErrorMsg(null);
    setProgress(null);
    setPreviewError(null);
    setPreviewData(null);
    setPreviewIndex(0);

    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSessionMeta(null);

    if (lastProcessedUrlRef.current) {
      URL.revokeObjectURL(lastProcessedUrlRef.current);
      lastProcessedUrlRef.current = null;
    }

    try {
      const buffer = await file.arrayBuffer();
      const session = await inspectPdfImages(buffer);
      sessionRef.current = session;
      setSessionMeta({
        totalImages: session.totalImages,
        compressibleCount: session.compressibleImages.length,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '解析 PDF 文件失败。');
    }
  };

  // 参数变化或切换预览索引时，防抖重算当前预览图
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || session.compressibleImages.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await renderPreviewForIndex(session, previewIndex, {
          quality: activePreset.quality,
          maxDimension: activePreset.maxDimension,
          smartFrequencyCompression,
          scanStrength,
          scanGrayscale,
        });
        if (cancelled) {
          URL.revokeObjectURL(res.processedUrl);
          return;
        }
        if (lastProcessedUrlRef.current) {
          URL.revokeObjectURL(lastProcessedUrlRef.current);
        }
        lastProcessedUrlRef.current = res.processedUrl;
        setPreviewData(res);
      } catch (err) {
        if (!cancelled) {
          setPreviewError(err instanceof Error ? err.message : '预览生成失败。');
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    sessionMeta,
    previewIndex,
    activePreset.quality,
    activePreset.maxDimension,
    smartFrequencyCompression,
    scanStrength,
    scanGrayscale,
  ]);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files?.[0]);
  };

  const handleCompress = async () => {
    if (!selectedFile || isProcessing) return;

    setIsProcessing(true);
    setErrorMsg(null);
    setResult(null);
    setProgress(null);

    try {
      const buffer = await selectedFile.arrayBuffer();
      const res = await compressPdfImages(
        buffer,
        {
          quality: activePreset.quality,
          maxDimension: activePreset.maxDimension,
          smartFrequencyCompression,
          scanStrength,
          scanGrayscale,
        },
        (current, total) => setProgress({ current, total })
      );
      setResult(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '处理过程中发生未知错误。');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownload = () => {
    if (!result || !selectedFile) return;
    const blob = new Blob([new Uint8Array(result.compressedBytes)], {
      type: 'application/pdf',
    });
    const url = URL.createObjectURL(blob);
    const baseName = selectedFile.name.replace(/\.pdf$/i, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}-compressed.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const progressPercent =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  const previewDeltaPercent =
    previewData && previewData.originalBytes > 0
      ? ((previewData.processedBytes - previewData.originalBytes) / previewData.originalBytes) * 100
      : 0;

  const renderPreviewImage = (src: string, alt: string, widthPx: number) => {
    if (zoomMode === 'fit') {
      return (
        <img
          src={src}
          alt={alt}
          className="max-w-full max-h-80 object-contain mx-auto block"
        />
      );
    }
    const scale = zoomMode === '200' ? 2 : 1;
    return (
      <img
        src={src}
        alt={alt}
        style={{ width: `${widthPx * scale}px`, maxWidth: 'none' }}
        className="block"
      />
    );
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center px-4 py-10 sm:py-12">
      <div className="w-full max-w-4xl space-y-6">
        {/* Header */}
        <header className="space-y-2 border-b border-zinc-800 pb-5">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
              PDF 内部图像精准压缩工具
            </h1>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
              纯前端本地运行
            </span>
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed">
            直接解析 PDF 底层对象树并压缩内嵌图像，保留矢量文本、公式与书签；支持频率感知自适应降噪、文档扫描漂白增强与实时对比预览。
          </p>
        </header>

        {/* File Upload */}
        <section>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => handleFileSelect(e.target.files?.[0])}
          />
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`rounded-lg border border-dashed p-5 transition-colors cursor-pointer flex items-center justify-between gap-4 ${
              isDragging
                ? 'border-slate-400 bg-slate-900/60'
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70'
            }`}
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="p-2.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300 shrink-0">
                {selectedFile ? <FileText className="w-5 h-5" /> : <Upload className="w-5 h-5" />}
              </div>
              <div className="min-w-0">
                {selectedFile ? (
                  <>
                    <p className="text-sm font-medium text-zinc-100 truncate">
                      {selectedFile.name}
                    </p>
                    <p className="text-xs font-mono text-zinc-400 mt-0.5">
                      原始大小：{formatBytes(selectedFile.size)}
                      {sessionMeta && (
                        <span className="text-zinc-500 ml-2">
                          · 共 {sessionMeta.totalImages} 张内嵌图（{sessionMeta.compressibleCount} 张可预览/处理）
                        </span>
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-zinc-200">
                      点击或拖拽 PDF 文件到此处
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      所有解析与图像编码均在浏览器内存中完成，文件不会上传至服务器
                    </p>
                  </>
                )}
              </div>
            </div>
            <span className="text-xs px-2.5 py-1.5 rounded bg-zinc-800 text-zinc-300 shrink-0">
              {selectedFile ? '更换文件' : '选择文件'}
            </span>
          </div>
        </section>

        {/* Parameters */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>压缩与扫描参数</span>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="preset-select" className="block text-sm text-zinc-300">
              压缩预设
            </label>
            <select
              id="preset-select"
              value={presetId}
              disabled={isProcessing}
              onChange={(e) => setPresetId(e.target.value as PresetOption['id'])}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-slate-500 disabled:opacity-50"
            >
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer select-none pt-1">
            <input
              type="checkbox"
              checked={smartFrequencyCompression}
              disabled={isProcessing}
              onChange={(e) => setSmartFrequencyCompression(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-950 accent-slate-500"
            />
            <span className="text-sm text-zinc-300">
              智能频率感知压缩（8×8 平坦背景区自动降噪省体积，高频文字笔迹保持锐利）
            </span>
          </label>

          {/* Document Scan Slider */}
          <div className="rounded-md border border-zinc-800/80 bg-zinc-950/50 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="scan-slider" className="text-sm text-zinc-200">
                文档扫描增强（白底黑字 / 去除底纹与阴影）
              </label>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                {scanStrength === 0 ? '关闭' : `${scanStrength}%`}
              </span>
            </div>
            <input
              id="scan-slider"
              type="range"
              min={0}
              max={100}
              step={5}
              value={scanStrength}
              disabled={isProcessing}
              onChange={(e) => setScanStrength(Number(e.target.value))}
              className="w-full accent-slate-300 cursor-pointer"
            />
            <div className="flex items-center justify-between text-[11px] text-zinc-500">
              <span>0%（保留原片色调）</span>
              <span>50%（适度漂白提亮）</span>
              <span>100%（强力白底黑字）</span>
            </div>

            {scanStrength > 0 && (
              <label className="flex items-center gap-2 cursor-pointer select-none pt-1 border-t border-zinc-800/70">
                <input
                  type="checkbox"
                  checked={scanGrayscale}
                  disabled={isProcessing}
                  onChange={(e) => setScanGrayscale(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-950 accent-slate-500"
                />
                <span className="text-xs text-zinc-400">
                  纯黑白灰度输出（去除彩色笔迹，进一步减小体积）
                </span>
              </label>
            )}
          </div>

          <div className="pt-1">
            <button
              type="button"
              disabled={!selectedFile || isProcessing}
              onClick={handleCompress}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-slate-200 px-4 py-2.5 text-sm font-medium text-zinc-950 hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>
                    正在处理全文档
                    {progress && progress.total > 0
                      ? ` (${progress.current}/${progress.total} 张图像)`
                      : '...'}
                  </span>
                </>
              ) : (
                <span>开始压缩并导出</span>
              )}
            </button>
          </div>

          {isProcessing && progress && progress.total > 0 && (
            <div className="space-y-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-slate-300 transition-all duration-150"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <p className="text-xs font-mono text-zinc-500 text-right">{progressPercent}%</p>
            </div>
          )}
        </section>

        {/* Live Preview Panel */}
        {sessionMeta && sessionMeta.compressibleCount > 0 && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
                <Eye className="w-3.5 h-3.5" />
                <span>实时效果预览</span>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                {/* Image Pagination */}
                <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-950">
                  <button
                    type="button"
                    disabled={previewIndex <= 0}
                    onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
                    className="p-1.5 text-zinc-400 hover:text-zinc-100 disabled:opacity-30 cursor-pointer"
                    title="上一张"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="px-2 font-mono text-zinc-300">
                    第 {previewIndex + 1} / {sessionMeta.compressibleCount} 张
                  </span>
                  <button
                    type="button"
                    disabled={previewIndex >= sessionMeta.compressibleCount - 1}
                    onClick={() =>
                      setPreviewIndex((i) =>
                        Math.min(sessionMeta.compressibleCount - 1, i + 1)
                      )
                    }
                    className="p-1.5 text-zinc-400 hover:text-zinc-100 disabled:opacity-30 cursor-pointer"
                    title="下一张"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* View Mode */}
                <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
                  {(
                    [
                      ['split', '并排对比'],
                      ['processed', '仅看效果'],
                      ['original', '仅看原图'],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setViewMode(mode)}
                      className={`px-2 py-1 rounded text-xs cursor-pointer transition-colors ${
                        viewMode === mode
                          ? 'bg-zinc-800 text-zinc-100'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Zoom Mode */}
                <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
                  {(
                    [
                      ['fit', '适应'],
                      ['100', '100%'],
                      ['200', '200%'],
                    ] as const
                  ).map(([z, label]) => (
                    <button
                      key={z}
                      type="button"
                      onClick={() => setZoomMode(z)}
                      className={`px-2 py-1 rounded font-mono text-xs cursor-pointer transition-colors ${
                        zoomMode === z
                          ? 'bg-zinc-800 text-zinc-100'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {previewError && (
              <p className="text-xs text-red-400">{previewError}</p>
            )}

            {previewData && (
              <>
                <div
                  className={`grid gap-3 ${
                    viewMode === 'split' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'
                  }`}
                >
                  {(viewMode === 'split' || viewMode === 'original') && (
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2.5 space-y-2">
                      <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
                        <span>原图 ({previewData.srcWidth}×{previewData.srcHeight})</span>
                        <span>{formatBytes(previewData.originalBytes)}</span>
                      </div>
                      <div className="max-h-80 overflow-auto rounded bg-zinc-900/60 p-1">
                        {renderPreviewImage(
                          previewData.originalUrl,
                          '原图预览',
                          previewData.srcWidth
                        )}
                      </div>
                    </div>
                  )}

                  {(viewMode === 'split' || viewMode === 'processed') && (
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2.5 space-y-2">
                      <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
                        <span>
                          处理后 ({previewData.targetWidth}×{previewData.targetHeight})
                          {previewLoading && ' · 更新中...'}
                        </span>
                        <span
                          className={
                            previewDeltaPercent < 0 ? 'text-emerald-400' : 'text-amber-400'
                          }
                        >
                          {formatBytes(previewData.processedBytes)} (
                          {previewDeltaPercent > 0 ? '+' : ''}
                          {previewDeltaPercent.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="max-h-80 overflow-auto rounded bg-zinc-900/60 p-1">
                        {renderPreviewImage(
                          previewData.processedUrl,
                          '处理后预览',
                          previewData.targetWidth
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {previewDeltaPercent >= 0 && (
                  <p className="text-[11px] text-zinc-500">
                    提示：当前预览图处理后体积未低于原图，正式导出时将按安全策略自动保留原图像流（若需应用扫描增强效果，可适当降低压缩质量或开启灰度输出）。
                  </p>
                )}
              </>
            )}

            {!previewData && previewLoading && (
              <div className="flex items-center justify-center py-10 text-xs text-zinc-400 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>正在解码预览图像...</span>
              </div>
            )}
          </section>
        )}

        {/* Error Message */}
        {errorMsg && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-4 flex items-start gap-3 text-sm text-red-300">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Result Panel */}
        {result && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>处理完成</span>
              </div>
              <span className="text-xs font-mono text-zinc-500">
                已启用 Object Streams 压缩
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
                <p className="text-xs text-zinc-500">原始大小</p>
                <p className="text-base font-mono font-medium text-zinc-200 mt-1">
                  {formatBytes(result.originalSize)}
                </p>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
                <p className="text-xs text-zinc-500">压缩后大小</p>
                <p className="text-base font-mono font-medium text-zinc-100 mt-1">
                  {formatBytes(result.compressedSize)}
                </p>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
                <p className="text-xs text-zinc-500">体积变化</p>
                <p
                  className={`text-base font-mono font-medium mt-1 ${
                    result.reductionPercent < 0 ? 'text-emerald-400' : 'text-zinc-300'
                  }`}
                >
                  {result.reductionPercent > 0 ? '+' : ''}
                  {result.reductionPercent.toFixed(1)}%
                </p>
              </div>
            </div>

            <div className="space-y-2 border-t border-zinc-800/80 pt-3.5 text-xs text-zinc-400">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  共扫描内嵌图像：<strong className="font-mono text-zinc-200">{result.totalImages}</strong> 张
                  {result.totalImages > 0 && (
                    <span className="text-zinc-500 ml-2">
                      (图像流 {formatBytes(result.totalImageBytesBefore)} → {formatBytes(result.totalImageBytesAfter)})
                    </span>
                  )}
                </span>
                <span>
                  成功优化：<strong className="font-mono text-emerald-400">{result.optimizedImages}</strong> 张
                  <span className="text-zinc-600 mx-1.5">|</span>
                  保留原样：<strong className="font-mono text-zinc-300">{result.skippedImages}</strong> 张
                </span>
              </div>

              {Object.keys(result.skipReasons).length > 0 && (
                <p className="text-zinc-500 leading-relaxed">
                  保留原样原因：
                  {Object.entries(result.skipReasons)
                    .map(([reason, count]) => `${reason} (${count})`)
                    .join('、')}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={handleDownload}
              className="w-full flex items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700 transition-colors cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>下载压缩后的 PDF</span>
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import { compressPdfImages, type CompressionResult } from './services/pdfCompressor';

interface PresetOption {
  id: 'light' | 'balanced' | 'extreme';
  label: string;
  quality: number;
  maxDimension: number;
}

const PRESETS: PresetOption[] = [
  {
    id: 'light',
    label: '轻度压缩（画质优先，质量 0.85，最大边 2400px）',
    quality: 0.85,
    maxDimension: 2400,
  },
  {
    id: 'balanced',
    label: '均衡压缩（推荐，质量 0.72，最大边 1800px）',
    quality: 0.72,
    maxDimension: 1800,
  },
  {
    id: 'extreme',
    label: '极限压缩（体积优先，质量 0.55，最大边 1200px）',
    quality: 0.55,
    maxDimension: 1200,
  },
];

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
  const [enableLowPassFilter, setEnableLowPassFilter] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CompressionResult | null>(null);

  const activePreset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[1];

  const handleFileSelect = (file: File | null | undefined) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMsg('请选择有效的 .pdf 文件。');
      return;
    }
    setSelectedFile(file);
    setResult(null);
    setErrorMsg(null);
    setProgress(null);
  };

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
          enableLowPassFilter,
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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center px-4 py-10 sm:py-14">
      <div className="w-full max-w-2xl space-y-6">
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
            直接解析 PDF 底层对象树并重压缩内嵌位图（Image Stream），保留原始矢量文本、公式、书签与超链接结构不变；仅在压缩后体积更小时替换原图流。
          </p>
        </header>

        {/* File Upload */}
        <section className="space-y-3">
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
            className={`rounded-lg border border-dashed p-6 transition-colors cursor-pointer flex items-center justify-between gap-4 ${
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
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-zinc-200">
                      点击或拖拽 PDF 文件到此处
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      所有处理均在浏览器内存中完成，文件不会上传至服务器
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
            <span>压缩参数</span>
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
              checked={enableLowPassFilter}
              disabled={isProcessing}
              onChange={(e) => setEnableLowPassFilter(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-950 accent-slate-500"
            />
            <span className="text-sm text-zinc-300">
              开启轻度低通滤波（去除扫描件噪点，进一步减小体积）
            </span>
          </label>

          <div className="pt-2">
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
                    正在处理
                    {progress && progress.total > 0
                      ? ` (${progress.current}/${progress.total} 张图像)`
                      : '...'}
                  </span>
                </>
              ) : (
                <span>开始压缩</span>
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

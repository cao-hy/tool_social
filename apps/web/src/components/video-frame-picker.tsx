import { Loader2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/toast-provider';
import clsx from 'clsx';

function dataUrlToBlob(dataUrl: string): Blob {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

interface VideoFramePickerProps {
  videoUrl: string;
  onUpload: (file: File) => Promise<void>;
  disabled?: boolean;
}

export function VideoFramePicker({ videoUrl, onUpload, disabled }: VideoFramePickerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [generating, setGenerating] = useState(true);
  const [uploading, setUploading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setFrames([]);
    setGenerating(true);
    let isCancelled = false;

    async function extractFrames() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      try {
        // Wait for metadata to load so we know duration
        if (video.readyState < 1) {
          await new Promise((resolve, reject) => {
            const onLoaded = () => {
              video.removeEventListener('loadedmetadata', onLoaded);
              video.removeEventListener('error', onError);
              resolve(null);
            };
            const onError = () => {
              video.removeEventListener('loadedmetadata', onLoaded);
              video.removeEventListener('error', onError);
              reject(
                new Error(
                  video.error
                    ? `Video load error: ${video.error.code} - ${video.error.message}`
                    : 'Unknown video load error',
                ),
              );
            };
            video.addEventListener('loadedmetadata', onLoaded);
            video.addEventListener('error', onError);
          });
        }

        if (isCancelled) return;

        const duration = video.duration || 0;
        const frameCount = 10;
        const intervals = Array.from(
          { length: frameCount },
          (_, i) => (duration / frameCount) * i + duration / frameCount / 2,
        );

        const extracted: string[] = [];

        for (const time of intervals) {
          if (isCancelled) return;

          await new Promise((resolve, reject) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              video.removeEventListener('error', onError);
              resolve(null);
            };
            const onError = () => {
              video.removeEventListener('seeked', onSeeked);
              video.removeEventListener('error', onError);
              reject(
                new Error(
                  video.error
                    ? `Video seek error: ${video.error.code} - ${video.error.message}`
                    : 'Unknown video seek error',
                ),
              );
            };
            video.addEventListener('seeked', onSeeked);
            video.addEventListener('error', onError);
            video.currentTime = time;
          });

          if (isCancelled) return;

          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            extracted.push(canvas.toDataURL('image/jpeg', 0.6));
          }
        }

        if (!isCancelled) {
          setFrames(extracted);
        }
      } catch (error: unknown) {
        console.error(error);
        if (!isCancelled) {
          toast.error(
            (error as Error).message || 'Lỗi khi trích xuất frame video (CORS/Network error).',
          );
        }
      } finally {
        if (!isCancelled) {
          setGenerating(false);
        }
      }
    }

    extractFrames();

    return () => {
      isCancelled = true;
    };
  }, [videoUrl, toast]);

  async function handleSave() {
    const dataUrl = frames[selectedIndex];
    if (!dataUrl) return;

    setUploading(true);
    try {
      const blob = dataUrlToBlob(dataUrl);
      const file = new File([blob], `frame-${Date.now()}.jpg`, { type: 'image/jpeg' });
      await onUpload(file);
    } catch (error: unknown) {
      console.error(error);
      toast.error('Lỗi khi lưu ảnh.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      {/* Hidden elements for processing */}
      <video
        ref={videoRef}
        src={videoUrl}
        crossOrigin="anonymous"
        className="hidden"
        muted
        playsInline
      />
      <canvas ref={canvasRef} className="hidden" />

      {generating ? (
        <div className="flex flex-col items-center justify-center py-10">
          <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
          <p className="mt-4 text-sm font-medium text-slate-600">
            Đang trích xuất các khung hình...
          </p>
        </div>
      ) : frames.length > 0 ? (
        <div className="space-y-4">
          <div className="relative overflow-hidden rounded-md bg-black">
            <img
              src={frames[selectedIndex]}
              alt="Selected frame preview"
              className="max-h-[300px] w-full object-contain"
            />
          </div>

          <div className="flex w-full gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-300">
            {frames.map((frame, index) => (
              <button
                key={index}
                type="button"
                disabled={disabled}
                onClick={() => setSelectedIndex(index)}
                className={clsx(
                  'relative h-16 w-24 shrink-0 overflow-hidden rounded border-2 transition-all',
                  index === selectedIndex
                    ? 'border-brand-500 opacity-100'
                    : 'border-transparent opacity-60 hover:opacity-100',
                )}
              >
                <img
                  src={frame}
                  alt={`Frame ${index + 1}`}
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>

          <div className="flex justify-end pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={handleSave}
              disabled={disabled || uploading}
              className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:pointer-events-none disabled:opacity-50"
            >
              {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Lưu frame đã chọn
            </button>
          </div>
        </div>
      ) : (
        <div className="py-6 text-center text-sm text-slate-500">
          Không thể tải video để trích xuất frame.
        </div>
      )}
    </div>
  );
}

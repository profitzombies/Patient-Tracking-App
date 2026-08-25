/**
 * Real playback for hosted training videos — shared by the editor preview
 * and the staff-facing lesson page.
 *
 * The <video> element streams straight from App Storage via a short-lived
 * signed URL (`useVideoMedia` below fetches it with the caller's staff
 * session and quietly re-mints before expiry), so seeking is the browser's
 * own range requests against storage. The control bar keeps the Heritage
 * player language: round play button, slim timeline with chapter ticks, and
 * a tabular clock. The timeline is a real slider — pointer scrubbing plus
 * arrow-key seeking — because a pointer-only click track would lock keyboard
 * users out of seeking.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Pause, Play } from 'lucide-react';
import { formatClock, type TrainingChapter } from '@/data/hq/training';
import {
  fetchMediaUrls,
  TrainingMediaError,
  type TrainingMediaUrls,
} from '@/lib/training-media';

/** Re-mint playback URLs this long before they lapse (they live ~3 h). */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface VideoMediaState {
  media: TrainingMediaUrls | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Signed playback URLs for one video. `enabled` gates the fetch — demo
 * personas have no staff session, so callers pass false and no doomed
 * request ever fires. Re-fetches when the hosted file changes (replace) and
 * shortly before the signed URLs expire.
 */
export function useVideoMedia(
  videoId: string,
  videoSource: string | null,
  enabled: boolean,
): VideoMediaState {
  const [media, setMedia] = useState<TrainingMediaUrls | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!videoSource || !enabled) {
      setMedia(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMediaUrls(videoId)
      .then((urls) => {
        if (!cancelled) setMedia(urls);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setMedia(null);
        setError(
          cause instanceof TrainingMediaError
            ? cause.message
            : 'Could not load the video — try again.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, videoSource, enabled, nonce]);

  // Quietly re-mint before the signed URLs lapse mid-viewing.
  useEffect(() => {
    if (!media) return;
    const waitMs = media.expiresAtMs - Date.now() - REFRESH_MARGIN_MS;
    if (waitMs <= 0) return;
    const timer = window.setTimeout(() => setNonce((n) => n + 1), waitMs);
    return () => window.clearTimeout(timer);
  }, [media]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { media, loading, error, reload };
}

export interface HostedVideoPlayerHandle {
  seekTo: (seconds: number) => void;
}

interface HostedVideoPlayerProps {
  src: string;
  poster?: string | null;
  chapters: TrainingChapter[];
  /** Catalog duration — replaced by the file's own metadata once loaded. */
  durationSeconds: number;
  /** Fires as playback advances (drives chapter highlights + "add at time"). */
  onTimeChange?: (seconds: number) => void;
  onEnded?: () => void;
  testId?: string;
}

export const HostedVideoPlayer = forwardRef<HostedVideoPlayerHandle, HostedVideoPlayerProps>(
  function HostedVideoPlayer(
    { src, poster, chapters, durationSeconds, onTimeChange, onEnded, testId },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const trackRef = useRef<HTMLDivElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(durationSeconds);
    const [mediaError, setMediaError] = useState<string | null>(null);
    const draggingRef = useRef(false);

    // A fresh source gets a fresh chance — stale errors must not stick to it.
    useEffect(() => setMediaError(null), [src]);

    const clampedDuration = Math.max(1, duration);

    const seekTo = useCallback(
      (seconds: number) => {
        const video = videoRef.current;
        if (!video) return;
        const next = Math.max(0, Math.min(seconds, clampedDuration));
        video.currentTime = next;
        setTime(next);
        onTimeChange?.(next);
      },
      [clampedDuration, onTimeChange],
    );

    useImperativeHandle(ref, () => ({ seekTo }), [seekTo]);

    const togglePlayback = () => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        // A rejected play() (e.g. a codec this browser can't decode) must
        // surface as a visible message, never an unhandled rejection.
        video.play().catch(() => {
          setMediaError("This browser can't play the video — try another browser, or re-upload it as MP4 (H.264).");
        });
      } else {
        video.pause();
      }
    };

    const timeFromPointer = (clientX: number): number => {
      const track = trackRef.current;
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      return pct * clampedDuration;
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      seekTo(timeFromPointer(event.clientX));
    };
    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) seekTo(timeFromPointer(event.clientX));
    };
    const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = false;
      event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault();
        seekTo(time + 5);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        event.preventDefault();
        seekTo(time - 5);
      } else if (event.key === 'Home') {
        event.preventDefault();
        seekTo(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        seekTo(clampedDuration);
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        togglePlayback();
      }
    };

    return (
      <div data-testid={testId}>
        <video
          ref={videoRef}
          src={src}
          poster={poster ?? undefined}
          preload="metadata"
          playsInline
          className="block aspect-video w-full bg-navy object-contain"
          onClick={togglePlayback}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            onEnded?.();
          }}
          onLoadedMetadata={(event) => {
            const metaDuration = event.currentTarget.duration;
            if (Number.isFinite(metaDuration) && metaDuration > 0) setDuration(metaDuration);
          }}
          onError={() => {
            setPlaying(false);
            setMediaError("This browser can't play the video — try another browser, or re-upload it as MP4 (H.264).");
          }}
          onTimeUpdate={(event) => {
            if (draggingRef.current) return;
            const current = event.currentTarget.currentTime;
            setTime(current);
            onTimeChange?.(current);
          }}
          data-testid={testId ? `${testId}-element` : undefined}
        />
        {mediaError && (
          <p
            role="alert"
            className="border-t border-border bg-secondary/50 px-4 py-2.5 text-[11px] leading-relaxed text-destructive"
            data-testid={testId ? `${testId}-media-error` : undefined}
          >
            {mediaError}
          </p>
        )}
        <div className="flex items-center gap-4 bg-secondary px-4 py-3">
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={togglePlayback}
            aria-label={playing ? 'Pause' : 'Play'}
            data-testid={testId ? `${testId}-toggle` : undefined}
          >
            {playing ? (
              <Pause size={14} className="fill-current" aria-hidden="true" />
            ) : (
              <Play size={14} className="ml-0.5 fill-current" aria-hidden="true" />
            )}
          </button>

          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(clampedDuration)}
            aria-valuenow={Math.round(time)}
            aria-valuetext={`${formatClock(Math.round(time))} of ${formatClock(Math.round(clampedDuration))}`}
            className="group relative flex h-10 flex-1 cursor-pointer touch-none items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown}
            data-testid={testId ? `${testId}-timeline` : undefined}
          >
            <div className="absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-border">
              <div
                className="absolute inset-y-0 left-0 bg-primary"
                style={{ width: `${(time / clampedDuration) * 100}%` }}
              />
            </div>
            {chapters.map((chapter) => {
              const pos = Math.max(0, Math.min(100, (chapter.at / clampedDuration) * 100));
              return (
                <div
                  key={chapter.id}
                  className="absolute top-1/2 z-10 -mt-1 h-2 w-0.5 rounded-full bg-foreground transition-colors group-hover:bg-primary"
                  style={{ left: `${pos}%` }}
                >
                  <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-navy px-2 py-1 text-[10px] font-bold text-card opacity-0 transition-opacity group-hover:opacity-100">
                    {formatClock(chapter.at)} · {chapter.title}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="w-20 shrink-0 text-right text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground tabular-nums">
            {formatClock(Math.round(time))} / {formatClock(Math.round(clampedDuration))}
          </div>
        </div>
      </div>
    );
  },
);

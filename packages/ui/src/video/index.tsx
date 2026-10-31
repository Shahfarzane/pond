import { Slider as SliderBase } from "@base-ui/react/slider";
import {
  IconFullScreen as FullscreenIcon,
  IconMediaPause as PauseIcon,
  IconMediaPlay as PlayIcon,
  IconVolume as VolumeIcon,
  IconVolumeOff as VolumeOffIcon,
} from "@pond/icons";
import { clsx as cn } from "clsx";
import { useMemo, useState } from "react";
import {
  useVideo,
  type VideoActions,
  VideoContext,
  type VideoContextValue,
} from "./context";
import { clamp, formatTime, SPEED_OPTIONS } from "./lib";
import styles from "./styles.module.css";
import { useAutoHide } from "./use-auto-hide";
import { useMediaState } from "./use-media-state";

const ICON = 16;

interface RootProps extends React.ComponentPropsWithoutRef<"div"> {
  frameRate?: number | null;
  chrome?: boolean;
  /** Element that enters full screen in place of the root, for controls rendered outside it. */
  fullscreenTarget?: HTMLElement | null;
}

function Root({
  className,
  children,
  frameRate,
  chrome,
  fullscreenTarget,
  ...props
}: RootProps) {
  const {
    state,
    actions: mediaActions,
    videoRef,
    rootRef,
    registerVideo,
  } = useMediaState(frameRate, fullscreenTarget);
  const { controlsVisible, showControls } = useAutoHide({
    rootRef,
    videoRef,
    ended: state.ended,
  });

  const actions = useMemo<VideoActions>(
    () => ({ ...mediaActions, showControls }),
    [mediaActions, showControls],
  );

  const visible = chrome || controlsVisible;

  const value = useMemo<VideoContextValue>(
    () => ({
      state: { ...state, controlsVisible: visible },
      actions,
      meta: { videoRef, rootRef, registerVideo },
      chrome: !!chrome,
    }),
    [state, visible, actions, videoRef, rootRef, registerVideo, chrome],
  );

  return (
    <VideoContext value={value}>
      <div ref={rootRef} className={cn(styles.root, className)} {...props}>
        {children}
      </div>
    </VideoContext>
  );
}

interface MediaProps extends React.ComponentPropsWithoutRef<"video"> {}

function Media({ className, children, ...props }: MediaProps) {
  const { meta } = useVideo();
  return (
    <video
      ref={meta.registerVideo}
      className={cn(styles.video, className)}
      playsInline
      {...props}
    >
      {children}
    </video>
  );
}

interface ControlsProps extends React.ComponentPropsWithoutRef<"div"> {}

function Controls({ className, children, ...props }: ControlsProps) {
  const { state, chrome } = useVideo();
  return (
    <div
      className={cn(styles.controls, className)}
      data-visible={state.controlsVisible ? "" : undefined}
      data-chrome={chrome || undefined}
      {...props}
    >
      {children}
    </div>
  );
}

function Row({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cn(styles.bar, className)} {...props}>
      {children}
    </div>
  );
}

type ButtonProps = Omit<React.ComponentPropsWithoutRef<"button">, "type">;

function PlayButton({ className, ...props }: ButtonProps) {
  const { state, actions } = useVideo();
  return (
    <button
      type="button"
      className={cn(styles.button, className)}
      onClick={actions.togglePlay}
      aria-label={state.playing ? "Pause" : "Play"}
      {...props}
    >
      {state.playing ? (
        <PauseIcon width={ICON} height={ICON} />
      ) : (
        <PlayIcon width={ICON} height={ICON} />
      )}
    </button>
  );
}

function MuteButton({ className, ...props }: ButtonProps) {
  const { state, actions } = useVideo();
  const muted = state.muted || state.volume === 0;
  return (
    <button
      type="button"
      className={cn(styles.button, className)}
      onClick={actions.toggleMute}
      aria-label={muted ? "Unmute" : "Mute"}
      {...props}
    >
      {muted ? (
        <VolumeOffIcon width={ICON} height={ICON} />
      ) : (
        <VolumeIcon width={ICON} height={ICON} />
      )}
    </button>
  );
}

function Volume({ className }: { className?: string }) {
  return <MuteButton className={className} />;
}

function CurrentTime({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">) {
  const { state } = useVideo();
  return (
    <span className={cn(styles.time, className)} {...props}>
      {formatTime(state.currentTime)}
    </span>
  );
}

function Duration({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">) {
  const { state } = useVideo();
  return (
    <span className={cn(styles.time, className)} {...props}>
      {formatTime(state.duration)}
    </span>
  );
}

function TimeDisplay({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  const { state, chrome } = useVideo();
  return (
    <div
      className={cn(styles["time-display"], className)}
      data-visible={chrome || state.controlsVisible ? "" : undefined}
      {...props}
    >
      <span>{formatTime(state.currentTime)}</span>
      <span className={styles["time-display-separator"]}>/</span>
      <span>{formatTime(state.duration)}</span>
    </div>
  );
}

interface ScrubberProps {
  className?: string;
  renderPreview?: (time: number) => React.ReactNode;
}

function Scrubber({ className, renderPreview }: ScrubberProps) {
  const { state, actions } = useVideo();
  const [hover, setHover] = useState<number | null>(null);
  const max = state.duration > 0 ? state.duration : 1;
  const current = Math.min(state.currentTime, max);
  const hasDuration = state.duration > 0;

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    setHover(clamp((event.clientX - rect.left) / rect.width, 0, 1));
  };

  return (
    <SliderBase.Root
      className={cn(styles.scrubber, className)}
      value={current}
      min={0}
      max={max}
      step={0.01}
      onValueChange={(v) => actions.seek(Array.isArray(v) ? (v[0] ?? 0) : v)}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
      aria-label="Seek"
    >
      {hover !== null && hasDuration ? (
        <span
          className={styles.preview}
          style={{
            left: `${hover * 100}%`,
            transform: "translateX(-50%)",
          }}
          aria-hidden
        >
          {renderPreview ? (
            <span className={styles["preview-media"]}>
              {renderPreview(hover * max)}
            </span>
          ) : null}
          <span className={styles["preview-time"]}>
            {formatTime(hover * max)}
          </span>
          <span className={styles["preview-line"]} />
        </span>
      ) : null}
      <SliderBase.Control className={styles.control}>
        <SliderBase.Track
          className={styles.track}
          data-buffering={state.buffering ? "" : undefined}
        >
          <div
            className={styles.buffer}
            style={{ width: `${(state.buffered / max) * 100}%` }}
          />
          {hover !== null ? (
            <div
              className={styles["hover-fill"]}
              style={{ width: `${hover * 100}%` }}
            />
          ) : null}
          <SliderBase.Indicator className={styles.indicator} />
          <SliderBase.Thumb className={styles.thumb} />
        </SliderBase.Track>
      </SliderBase.Control>
    </SliderBase.Root>
  );
}

interface SpeedSelectProps {
  className?: string;
  options?: readonly number[];
}

function SpeedSelect({ className, options = SPEED_OPTIONS }: SpeedSelectProps) {
  const { state, actions } = useVideo();
  return (
    <select
      className={cn(styles.speed, className)}
      value={state.rate}
      onChange={(event) => actions.setRate(Number(event.target.value))}
      aria-label="Playback Speed"
    >
      {options.map((rate) => (
        <option key={rate} value={rate}>
          {rate}×
        </option>
      ))}
    </select>
  );
}

function FullscreenButton({ className, ...props }: ButtonProps) {
  const { state, actions } = useVideo();
  if (!state.fullscreenSupported) return null;
  return (
    <button
      type="button"
      className={cn(styles.button, className)}
      onClick={actions.toggleFullscreen}
      aria-label={state.fullscreen ? "Exit full screen" : "Full screen"}
      {...props}
    >
      <FullscreenIcon width={ICON} height={ICON} />
    </button>
  );
}

function Spacer() {
  return <div className={styles.spacer} />;
}

export const Video = {
  Root,
  Media,
  Controls,
  Row,
  PlayButton,
  MuteButton,
  Volume,
  CurrentTime,
  Duration,
  TimeDisplay,
  Scrubber,
  SpeedSelect,
  FullscreenButton,
  Spacer,
};

const SPEEDS = [0.5, 1, 2, 5, 20, 100];

export function PlaybackBar({
  running,
  tps,
  tick,
  pop,
  speciesCount,
  onPlayPause,
  onSpeed,
  onStep,
}: {
  running: boolean;
  tps: number;
  tick: number;
  pop: number;
  speciesCount: number;
  onPlayPause: () => void;
  onSpeed: (multiplier: number) => void;
  onStep: (ticks: number) => void;
}) {
  const multiplier = Math.round((tps / 60) * 10) / 10;
  return (
    <div className="flex items-center gap-4 border-t border-lab-border bg-lab-panel/90 px-4 py-2.5 backdrop-blur">
      <button
        onClick={onPlayPause}
        className={`flex h-10 w-10 items-center justify-center rounded-full text-sm leading-none shadow-lg transition-all active:scale-95 ${
          running
            ? 'bg-lab-accent text-lab-bg shadow-lab-accent/25 hover:bg-lab-accent-dim'
            : 'bg-lab-border text-lab-text shadow-black/30 hover:bg-[#2a3442]'
        }`}
        title={running ? '暂停 (生命继续演化)' : '运行'}
      >
        {running ? '❚❚' : '▶'}
      </button>

      {/* 变速：分段滑轨控件 */}
      <div className="flex items-center rounded-full border border-lab-border bg-[#0d121b] p-0.5">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => onSpeed(s)}
            className={`rounded-full px-2.5 py-1 text-xs transition-all ${
              Math.abs(multiplier - s) < 0.05
                ? 'bg-lab-accent/15 text-lab-accent shadow-[inset_0_0_0_1px_rgba(52,211,153,0.35)]'
                : 'text-lab-muted hover:text-lab-text'
            }`}
          >
            {s}x
          </button>
        ))}
      </div>

      {/* 单步 */}
      <div className="flex items-center gap-1 rounded-full border border-lab-border bg-[#0d121b] p-0.5">
        <span className="px-2 text-xs text-lab-muted">单步</span>
        {[1, 10, 100].map((n) => (
          <button
            key={n}
            onClick={() => onStep(n)}
            className="rounded-full px-2 py-1 text-xs text-lab-muted transition-colors hover:bg-lab-border hover:text-lab-text"
            title={`前进 ${n} tick`}
          >
            +{n}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-5 font-mono text-sm">
        <span className="text-lab-muted">
          tick <span className="text-lab-text">{tick.toLocaleString()}</span>
        </span>
        <span className="text-lab-muted">
          个体 <span className="text-lab-text">{pop.toLocaleString()}</span>
        </span>
        <span className="text-lab-muted">
          物种 <span className="text-lab-text">{speciesCount}</span>
        </span>
      </div>
    </div>
  );
}

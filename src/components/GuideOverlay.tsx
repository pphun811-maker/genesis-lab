const GUIDE_KEY = 'gl-hint-observatory-v1';

export function shouldShowGuide(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) !== '1';
  } catch {
    return true;
  }
}

export function dismissGuide(): void {
  try {
    localStorage.setItem(GUIDE_KEY, '1');
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

const TIPS: Array<{ icon: string; title: string; body: string }> = [
  {
    icon: '▶️',
    title: '让世界转起来',
    body: '底部控制条：播放/暂停，0.5×–100× 变速；等不及演化就用高倍速，想细看就单步 +1/+10/+100。',
  },
  {
    icon: '🖱️',
    title: '触摸每个生命',
    body: '画布上按住拖动平移（1:1 跟手）、滚轮缩放；点击任意个体查看它的基因、能量，还能开启跟随镜头看它的一生。',
  },
  {
    icon: '📊',
    title: '读懂世界',
    body: '右侧标签页：指标看种群与基因曲线，物种看势力分布，事件流会播报物种分化和灭绝，规则页可以随时修改世界法则。',
  },
  {
    icon: '⑂',
    title: '扮演上帝',
    body: '顶栏「⑂ 分叉实验」在任意时刻复制一个平行世界——改一条规则再放回去跑，去对比页看两条命运如何分岔。',
  },
];

export function GuideOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-lab-bg/70 p-6 backdrop-blur-[3px]">
      <div className="w-[560px] max-w-full rounded-2xl border border-lab-border bg-lab-panel/95 p-6 shadow-2xl shadow-black/60">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-lg">🧬</span>
          <h2 className="text-base font-medium">观察舱指南</h2>
          <span className="ml-auto text-xs text-lab-muted">只需 30 秒</span>
        </div>
        <p className="mb-4 text-xs text-lab-muted">
          这是一个正在运行的演化沙盘——生命会觅食、繁殖、竞争、突变。你需要做的只有观察和干预。
        </p>
        <div className="mb-5 grid grid-cols-2 gap-3">
          {TIPS.map((t) => (
            <div
              key={t.title}
              className="rounded-xl border border-lab-border bg-[#0d121b] p-3.5 transition-colors hover:border-[#2f3b4c]"
            >
              <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                <span>{t.icon}</span>
                {t.title}
              </div>
              <p className="text-xs leading-5 text-lab-muted">{t.body}</p>
            </div>
          ))}
        </div>
        <div className="flex items-center">
          <span className="text-xs text-lab-muted">顶栏的 ？ 可随时再看</span>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg bg-lab-accent px-6 py-2 text-sm font-medium text-lab-bg transition-colors hover:bg-lab-accent-dim"
          >
            开始探索 →
          </button>
        </div>
      </div>
    </div>
  );
}

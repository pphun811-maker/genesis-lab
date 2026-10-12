import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { simManager } from '../client/simManager';
import { deserializeExperiment } from '../persistence/serialize';
import { useExperiments } from '../store/experiments';
import type { ExperimentRecord } from '../store/types';

export function HomeView() {
  const navigate = useNavigate();
  const records = useExperiments((s) => s.records);
  const remove = useExperiments((s) => s.remove);
  const importRecord = useExperiments((s) => s.importRecord);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const list = Object.values(records);

  // 家族树：根实验按创建时间排序，分支缩进挂在父实验之后
  const childrenOf = new Map<string, ExperimentRecord[]>();
  const roots: ExperimentRecord[] = [];
  for (const r of list) {
    if (r.parentId && records[r.parentId]) {
      const arr = childrenOf.get(r.parentId) ?? [];
      arr.push(r);
      childrenOf.set(r.parentId, arr);
    } else {
      roots.push(r);
    }
  }
  roots.sort((a, b) => b.createdAt - a.createdAt);
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.createdAt - b.createdAt);

  const runningCount = simManager.runningIds().length;

  const renderTree = (items: ExperimentRecord[], depth: number): React.ReactNode =>
    items.map((r) => (
      <div key={r.id} style={{ marginLeft: depth * 24 }}>
        <ExperimentCard
          record={r}
          parentName={r.parentId ? records[r.parentId]?.name : undefined}
          onOpen={() => navigate(`/exp/${r.id}`)}
          onToggleRun={() => {
            const client = simManager.get(r.id);
            if (client?.running) client.pause();
            else simManager.ensure(r.id, { spec: r.spec, snapshot: r.snapshot }), simManager.run(r.id);
          }}
          onDelete={() => {
            if (confirm(`删除实验「${r.name}」？其分支将保留，此操作不可恢复。`)) {
              simManager.dispose(r.id);
              remove(r.id);
            }
          }}
        />
        {renderTree(childrenOf.get(r.id) ?? [], depth + 1)}
      </div>
    ));

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-8 flex items-center">
        <div>
          <h1 className="text-xl font-semibold">🧬 Genesis Lab</h1>
          <p className="mt-1 text-sm text-lab-muted">
            创造世界，运行演化，观察涌现，分叉实验。
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {runningCount > 0 && (
            <span className="text-xs text-lab-muted">
              并行 {runningCount}/{simManager.maxRunning}
            </span>
          )}
          {list.length > 0 && (
            <button
              onClick={() => navigate('/compare')}
              className="rounded-lg border border-lab-border px-4 py-2.5 text-sm text-lab-muted hover:text-lab-text"
            >
              ⚖ 对比
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg border border-lab-border px-4 py-2.5 text-sm text-lab-muted hover:text-lab-text"
          >
            ⤒ 导入
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              file
                .text()
                .then((text) => {
                  const rec = deserializeExperiment(text);
                  const id = importRecord(rec);
                  navigate(`/exp/${id}`);
                })
                .catch((err) => alert('导入失败：' + (err instanceof Error ? err.message : err)));
            }}
          />
          <button
            onClick={() => navigate('/create')}
            className="rounded-lg bg-lab-accent px-5 py-2.5 text-sm font-medium text-lab-bg hover:bg-lab-accent-dim"
          >
            ＋ 新建世界
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="mt-20 text-center text-lab-muted">
          <div className="mb-3 text-4xl">🌍</div>
          <p className="text-sm">还没有实验。三步开始你的第一次创世：</p>
          <div className="mx-auto mt-6 grid max-w-2xl grid-cols-3 gap-3 text-left">
            {[
              { n: '1', t: '创造世界', d: '一句话描述，或选预设、调参数', i: '🌍' },
              { n: '2', t: '观察演化', d: '吃与被吃、突变与灭绝，都在实时发生', i: '🔬' },
              { n: '3', t: '分叉对比', d: '任意时刻分叉平行世界，改规则看分岔', i: '⑂' },
            ].map((s) => (
              <div
                key={s.n}
                className="rounded-xl border border-lab-border bg-lab-panel p-4 transition-colors hover:border-[#2f3b4c]"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-lab-accent/15 text-xs text-lab-accent">
                    {s.n}
                  </span>
                  <span className="text-sm font-medium text-lab-text">
                    {s.i} {s.t}
                  </span>
                </div>
                <p className="text-xs leading-5">{s.d}</p>
              </div>
            ))}
          </div>
          <button
            onClick={() => navigate('/create')}
            className="mt-6 rounded-lg bg-lab-accent px-6 py-2.5 text-sm font-medium text-lab-bg transition-colors hover:bg-lab-accent-dim"
          >
            ＋ 现在创造
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">{renderTree(roots, 0)}</div>
      )}
    </div>
  );
}

function ExperimentCard({
  record: r,
  parentName,
  onOpen,
  onToggleRun,
  onDelete,
}: {
  record: ExperimentRecord;
  parentName?: string;
  onOpen: () => void;
  onToggleRun: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group cursor-pointer rounded-xl border border-lab-border bg-lab-panel p-4 transition-all hover:-translate-y-px hover:border-lab-accent/40 hover:shadow-[0_4px_24px_rgba(0,0,0,0.35),0_0_20px_rgba(52,211,153,0.06)]"
      onClick={onOpen}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${
            r.running ? 'animate-pulse bg-lab-accent' : 'bg-lab-muted'
          }`}
        />
        <span className="font-medium">{r.name}</span>
        {r.parentId && parentName && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="rounded bg-lab-border px-1.5 py-0.5 text-xs text-lab-muted hover:text-lab-text"
            title={`分叉自「${parentName}」第 ${r.forkedAtTick ?? 0} tick`}
          >
            ↳ {parentName} @{r.forkedAtTick ?? 0}
          </button>
        )}
        <span className="ml-auto text-xs text-lab-muted">
          tick {r.lastTick.toLocaleString()}
        </span>
      </div>
      <div className="mt-2 flex gap-4 text-xs text-lab-muted">
        <span>个体 {r.lastPop.toLocaleString()}</span>
        <span>物种 {Object.keys(r.species).length}</span>
        <span>
          {new Date(r.createdAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
          创建
        </span>
      </div>
      <div
        className="mt-3 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onOpen}
          className="rounded border border-lab-border px-3 py-1 text-xs hover:text-lab-text"
        >
          进入观察舱
        </button>
        <button
          onClick={onToggleRun}
          className="rounded border border-lab-border px-3 py-1 text-xs hover:text-lab-text"
        >
          {r.running ? '暂停' : '继续'}
        </button>
        <button
          onClick={onDelete}
          className="ml-auto rounded border border-lab-border px-3 py-1 text-xs text-lab-muted hover:text-red-400"
        >
          删除
        </button>
      </div>
    </div>
  );
}

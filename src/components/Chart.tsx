import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

/** ECharts 薄封装：初始化一次，option 变化时完全替换，自动响应尺寸 */
export function Chart({
  option,
  height,
}: {
  option: echarts.EChartsCoreOption;
  height: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = ref.current!;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    // notMerge：切换指标类型时丢弃全部旧系列，避免残留
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}

/** 数字紧凑化：1000 → 1k、2500 → 2.5k */
export function fmtK(v: number): string {
  if (Math.abs(v) >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(v);
}

/** 深色主题的公共图表配置片段（tooltip 不溢出、刻度不挤压） */
export const CHART_BASE = {
  textStyle: { color: '#7d8899', fontSize: 11 },
  grid: { left: 42, right: 18, top: 16, bottom: 28 },
  tooltip: {
    trigger: 'axis' as const,
    confine: true, // 悬浮卡片收在图内，不被侧栏滚动容器裁剪
    backgroundColor: 'rgba(22, 29, 41, 0.95)',
    borderColor: '#2a3442',
    padding: [6, 10],
    textStyle: { color: '#d7dee8', fontSize: 12 },
    formatter: (params: unknown): string => {
      const arr = (Array.isArray(params) ? params : [params]) as Array<{
        marker: string;
        seriesName: string;
        value: [number, number];
      }>;
      if (arr.length === 0) return '';
      const tick = Math.round(arr[0].value[0]);
      const rows = arr
        .map(
          (p) =>
            `${p.marker} ${p.seriesName}&nbsp;&nbsp;<b style="font-family:ui-monospace,monospace">${Number(
              p.value[1],
            ).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b>`,
        )
        .join('<br/>');
      return `<div style="font-size:10px;color:#7d8899;margin-bottom:3px">tick ${tick.toLocaleString()}</div>${rows}`;
    },
  },
  xAxis: {
    type: 'value' as const,
    name: 'tick',
    nameTextStyle: { color: '#7d8899', fontSize: 10 },
    axisLine: { lineStyle: { color: '#2a3442' } },
    axisLabel: { color: '#7d8899', hideOverlap: true, formatter: fmtK },
    splitLine: { show: false },
  },
  yAxis: {
    type: 'value' as const,
    axisLabel: { color: '#7d8899', hideOverlap: true, formatter: fmtK },
    splitNumber: 3,
    splitLine: { lineStyle: { color: '#1a2130' } },
  },
};

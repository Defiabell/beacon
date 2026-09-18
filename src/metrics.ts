import type { SourceRun } from './types';

export interface MetricCoverage {
  start: string;
  end: string;
  expectedDays: number;
  observedDays: number;
  lastDate: string | null;
  status: 'complete' | 'partial' | 'missing' | 'failed' | 'stale' | 'unconfigured';
}

export function metricCoverage(days: number, observedDays: number, lastDate: string | null, today: string, source?: SourceRun): MetricCoverage {
  const date = new Date(`${today}T00:00:00Z`);
  const shift = (n: number) => new Date(date.getTime() + n * 86400000).toISOString().slice(0, 10);
  const status = source?.error === 'not configured' || source?.error === 'no sites configured' ? 'unconfigured'
    : source && !source.ok ? 'failed'
    : source && source.lastRunAt.slice(0, 10) < shift(-1) ? 'stale'
    : observedDays === 0 ? 'missing'
    : observedDays < days ? 'partial' : 'complete';
  return { start: shift(-days), end: shift(-1), expectedDays: days, observedDays, lastDate, status };
}

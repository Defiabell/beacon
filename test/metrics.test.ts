import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getRepoSeries, getSiteTotals, getSitePvSum, getWorkerTotals, upsertRepoDaily, upsertSiteDaily, upsertWorkerDaily } from '../src/db';
import { metricCoverage } from '../src/metrics';
import { renderOverview } from '../src/ui/pages';

const today = '2026-09-18';

describe('calendar windows and missing data', () => {
  it('excludes old fallback rows and today; gaps remain visible', async () => {
    await upsertRepoDaily(env.DB, ['2026-08-01', '2026-09-03', '2026-09-04', '2026-09-17', '2026-09-18'].map(date => ({
      repo: 'example/window', date, views: 100, uniqueViews: 2, clones: 4, uniqueClones: 2, stars: 0, forks: 0
    })));
    const rows = await getRepoSeries(env.DB, 'example/window', 14, today);
    expect(rows.map(r => r.date)).toEqual(['2026-09-04', '2026-09-17']);
    expect(metricCoverage(14, rows.length, rows.at(-1)!.date, today)).toMatchObject({ status: 'partial', observedDays: 2, start: '2026-09-04', end: '2026-09-17' });
  });

  it('distinguishes complete zero observations from no observations', async () => {
    await upsertSiteDaily(env.DB, Array.from({ length: 7 }, (_, i) => ({ site: 'zero.test', date: `2026-09-${11 + i}`, pageviews: 0, visitors: 0 })));
    await upsertSiteDaily(env.DB, [{ site: 'old.test', date: '2026-08-01', pageviews: 900, visitors: 9 }, { site: 'zero.test', date: today, pageviews: 888, visitors: 8 }]);
    const totals = await getSiteTotals(env.DB, 7, today);
    expect(totals.find(s => s.site === 'old.test')).toMatchObject({ pageviews: null, visitors: null, days: 0 });
    expect(totals.find(s => s.site === 'zero.test')).toMatchObject({ pageviews: 0, visitors: 0, days: 7 });
    expect(await getSitePvSum(env.DB, 7, today)).toBe(0);
    expect(await getSitePvSum(env.DB, 7, '2026-10-01')).toBeNull();
    expect(metricCoverage(7, 7, '2026-09-17', today).status).toBe('complete');
    expect(metricCoverage(7, 0, null, today).status).toBe('missing');
  });

  it('does not make stale workers disappear or report them as zero', async () => {
    await upsertWorkerDaily(env.DB, [{ script: 'old-worker', date: '2026-08-01', requests: 500, errors: 0, subrequests: 0 }]);
    const totals = await getWorkerTotals(env.DB, 7, today);
    expect(totals.find(s => s.script === 'old-worker')).toMatchObject({ requests: null, days: 0, lastDate: null });
  });

  it('shows failed or stale collection even when old samples exist', () => {
    const failed = metricCoverage(7, 2, '2026-09-12', today, { source: 'rum', lastRunAt: today, ok: false, error: '403' });
    expect(failed.status).toBe('failed');
    expect(metricCoverage(7, 7, '2026-09-17', today, { source: 'rum', lastRunAt: '2026-09-15', ok: true, error: null }).status).toBe('stale');
    const html = renderOverview({ projects: [], topTodos: [], suggestions: [], sources: [], sitePv7d: null,
      surfaces: { surfaces: [], unclassified: [], since: null }, workers: [],
      sites: [{ site: 'no-data.test', pageviews: null, visitors: null, days: 0, lastDate: null, coverage: failed }]
    }, false);
    expect(html).toContain('采集失败');
    expect(html).toContain('— 次浏览');
    expect(html).not.toContain('null 次浏览');
    expect(html).toContain('2026-09-11 至 2026-09-17');
  });
});

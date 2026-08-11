// Machine-traffic separation (design doc §3). classifyDay is a pure derived
// view over a single repo_daily row — it never touches the database and
// never drops data; repo_daily itself is left completely untouched. Callers
// (src/impact/attribute.ts, src/ui/pages.ts) always keep the raw row around
// alongside whatever this returns.
//
// Rule, validated against production data (not a guess): the days with the
// highest clone counts were *all* zero-view days — nightide 07-28 was 0 views
// / 38 clones, screen-coach 08-02 was 0 views / 29 clones. A human clone is
// preceded by at least one page view (you have to find the repo before you
// can `git clone` it), so a day with zero unique visitors but nonzero clones
// can only be CI mirrors or scraper/bot activity.
import type { RepoDaily } from "../types";

export interface ClassifiedDay {
  date: string;
  humanViews: number;
  humanClones: number;
  machineClones: number;
}

export function classifyDay(row: Pick<RepoDaily, "date" | "views" | "uniqueViews" | "clones">): ClassifiedDay {
  const isMachineDay = row.uniqueViews === 0 && row.clones > 0;
  return {
    date: row.date,
    // Views aren't split human/machine — the rule above only reclassifies
    // clones (see the design doc: it's specifically clone counts that spike
    // on zero-view days, not view counts themselves).
    humanViews: row.views,
    humanClones: isMachineDay ? 0 : row.clones,
    machineClones: isMachineDay ? row.clones : 0
  };
}

import { useEffect, useState } from 'react';
import DashboardLayout from './DashboardLayout';
import { DashboardTick } from './refreshBus';
import KpiStrip from './components/KpiStrip';
import WorkforceActivity from './components/WorkforceActivity';
import ProductivityOverview from './components/ProductivityOverview';
import WorkPatternHeatmap from './components/WorkPatternHeatmap';
import FleetHealthPanel from './components/FleetHealthPanel';
import DepartmentPanel from './components/DepartmentPanel';
import TopApplications from './components/TopApplications';
import RiskPanel from './components/RiskPanel';
import AgentTable from './components/AgentTable';
import TimeTracker from './components/TimeTracker';
import FilterBar from './components/FilterBar';
import { SectionBand } from './components/ui';
import { DashFilterContext, defaultFilter, type DashFilter } from './filterContext';

/* Spacing is tiered on purpose: 10px between panels inside a row, 16px between
   sections. Equal gaps everywhere is what made an earlier version read as an
   undifferentiated wall — the eye needs the larger gap to know a new idea has
   started. Each band is labelled, and panels stagger in on mount by index.

   No page-level header: the shell already names the route, and the KPI strip is
   the first thing worth reading. */

const AUTO_REFRESH_MS = 60_000;

export default function Dashboard() {
  // Every panel subscribes to this tick and re-fetches in place, so data stays
  // live without the page reloading — filters, selected ranges and scroll
  // position all survive a refresh.
  const [tick, setTick] = useState(0);
  // Agent + date-range filter. Deliberately not persisted: coming back to a
  // dashboard silently scoped to last month is worse than re-picking it.
  const [filter, setFilter] = useState<DashFilter>(defaultFilter);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Bump the tick immediately whenever the filter changes so every panel
  // that subscribes via useRefreshOnTick re-fetches with the new scope
  // right away. Prior behaviour was to wait for the next 60 s tick, which
  // reads as "the filter didn't work" for the whole minute after the click.
  useEffect(() => {
    setTick((t) => t + 1);
  }, [filter]);

  return (
    <DashboardLayout>
      <DashboardTick.Provider value={tick}>
        <DashFilterContext.Provider value={filter}>
        <div className="dash">
          <FilterBar filter={filter} onChange={setFilter} />

          {/* ------------------------------------------------ right now ---- */}
          <div className="space-y-2.5">
            <KpiStrip />

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5">
              <div className="lg:col-span-8 min-w-0 flex">
                <WorkforceActivity index={1} />
              </div>
              <div className="lg:col-span-4 min-w-0 flex">
                <ProductivityOverview index={2} />
              </div>
            </div>
          </div>

          {/* ---------------------------------------------- attendance ---- */}
          <div className="mt-4 space-y-2.5">
            <SectionBand label="Attendance" />
            <TimeTracker index={9} />
          </div>

          {/* -------------------------------------------- patterns / ops ---- */}
          <div className="mt-4 space-y-2.5">
            <SectionBand label="Patterns & operations" />
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5">
              <div className="lg:col-span-8 min-w-0 flex">
                <WorkPatternHeatmap index={3} />
              </div>
              <div className="lg:col-span-4 min-w-0 flex">
                <FleetHealthPanel index={4} />
              </div>
            </div>
          </div>

          {/* ------------------------------------------------ breakdowns ---- */}
          <div className="mt-4 space-y-2.5">
            <SectionBand label="Breakdowns" />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
              <div className="min-w-0 flex">
                <DepartmentPanel index={5} />
              </div>
              <div className="min-w-0 flex">
                <TopApplications index={6} />
              </div>
              <div className="min-w-0 flex">
                <RiskPanel index={7} />
              </div>
            </div>
          </div>

          {/* ----------------------------------------------------- fleet ---- */}
          <div className="mt-4 space-y-2.5">
            <SectionBand label="Fleet" />
            <AgentTable index={8} />
          </div>
        </div>
        </DashFilterContext.Provider>
      </DashboardTick.Provider>
    </DashboardLayout>
  );
}

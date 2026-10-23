import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider, Spinner } from "./components/ui";
import Landing from "./landing/Landing";
import { RevealObserver, SmoothScroll, scrollToY } from "./lib/scrollfx";

const DemoLayout = lazy(() => import("./demo/DemoLayout"));
const Demo = lazy(() => import("./demo/Demo"));
const Presentation = lazy(() => import("./demo/Presentation"));
const AppShell = lazy(() => import("./app/AppShell"));
const Overview = lazy(() => import("./app/pages/Overview"));
const Businesses = lazy(() => import("./app/pages/Businesses"));
const NewProject = lazy(() => import("./app/pages/NewProject"));
const TwinBuilder = lazy(() => import("./app/pages/TwinBuilder"));
const Worlds = lazy(() => import("./app/pages/Worlds"));
const Simulations = lazy(() => import("./app/pages/Simulations"));
const RunDetail = lazy(() => import("./app/pages/RunDetail"));
const Lab = lazy(() => import("./app/pages/Lab"));
const Reports = lazy(() => import("./app/pages/Reports"));
const ReportView = lazy(() => import("./app/pages/ReportView"));
const FailureMuseum = lazy(() => import("./app/pages/FailureMuseum"));
const Feedback = lazy(() => import("./app/pages/Feedback"));
const LiveData = lazy(() => import("./app/pages/LiveData"));
const Research = lazy(() => import("./app/pages/Research"));
const WIDashboard = lazy(() => import("./whatif/pages/Dashboard"));
const WISimulate = lazy(() => import("./whatif/pages/Simulate"));
const WIRisk = lazy(() => import("./whatif/pages/RiskRadar"));
const WICompare = lazy(() => import("./whatif/pages/Compare"));
const WISetup = lazy(() => import("./whatif/pages/Setup"));
const WIReports = lazy(() => import("./whatif/pages/Reports"));
const WIReportView = lazy(() => import("./whatif/pages/Reports").then((m) => ({ default: m.ReportView })));
const WISettings = lazy(() => import("./whatif/pages/Settings"));


function Loading() {
  return <div className="grid min-h-[50vh] place-items-center text-text-3"><Spinner size={22} /></div>;
}

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) scrollToY(0);
  }, [pathname, hash]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SmoothScroll />
        <RevealObserver />
        <ScrollToTop />
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/demo" element={<DemoLayout />}>
              <Route index element={<Demo />} />
              <Route path="present" element={<Presentation />} />
            </Route>
            {/* No accounts: the workspace opens directly in this browser. */}
            <Route path="/app" element={<AppShell />}>
              <Route index element={<WIDashboard />} />
              <Route path="simulate" element={<WISimulate />} />
              <Route path="risk" element={<WIRisk />} />
              <Route path="compare" element={<WICompare />} />
              <Route path="setup" element={<WISetup />} />
              <Route path="reports" element={<WIReports />} />
              <Route path="reports/w/:id" element={<WIReportView />} />
              <Route path="reports/legacy" element={<Reports />} />
              <Route path="settings" element={<WISettings />} />
              {/* Retail lab (the original Monte Carlo digital-twin tools) */}
              <Route path="overview" element={<Overview />} />
              <Route path="businesses" element={<Businesses />} />
              <Route path="new" element={<NewProject />} />
              <Route path="twin" element={<TwinBuilder />} />
              <Route path="worlds" element={<Worlds />} />
              <Route path="simulations" element={<Simulations />} />
              <Route path="runs/:runId" element={<RunDetail />} />
              <Route path="lab" element={<Lab />} />
              <Route path="reports/:reportId" element={<ReportView />} />
              <Route path="failures" element={<FailureMuseum />} />
              <Route path="feedback" element={<Feedback />} />
              <Route path="live" element={<LiveData />} />
              <Route path="research" element={<Research />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  );
}

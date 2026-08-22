import { useState } from "react";
import { ArrowUpRight, Download, Target } from "lucide-react";
import { MOCK_ANALYTICS, MOCK_PROVIDERS } from "@/data/mock-data";

export default function Analytics() {
  const [range, setRange] = useState("Year to Date");
  const rangeScale = range === 'Last 30 Days' ? 1 : range === 'Last 6 Months' ? 5.6 : 10.8;
  const displayedRevenue = Math.round(MOCK_ANALYTICS.monthlyRevenue * rangeScale);
  const displayedRecurringRevenue = Math.round(MOCK_ANALYTICS.recurringRevenue * rangeScale);
  const displayedEnrollmentRevenue = Math.round(MOCK_ANALYTICS.enrollmentRevenue * rangeScale);

  const downloadSnapshot = () => {
    const rows = [
      ['Period', range],
      ['Total revenue', displayedRevenue],
      ['Recurring subscriptions', displayedRecurringRevenue],
      ['New enrollments', displayedEnrollmentRevenue],
      ['Average pounds lost', MOCK_ANALYTICS.averagePoundsLost],
      ['Average goal completion', MOCK_ANALYTICS.averageGoalCompletion],
      ['Protocol retention', MOCK_ANALYTICS.retention],
    ];
    const csv = rows.map((row) => row.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `thinnr-demo-outcomes-${range.toLowerCase().replaceAll(' ', '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[32px] leading-none tracking-[-.04em] text-[#172c56]">Revenue & Outcomes</h1>
          <p className="mt-2 text-sm text-[#718099]">Synthetic practice performance, cohort analysis, and outcome tracking.</p>
        </div>
        <div className="flex gap-2">
          <label className="flex h-9 items-center gap-2 border border-[#bdc9dc] bg-[#f8f9fc] px-3 text-xs font-semibold text-[#344c77] transition focus-within:border-[#315fc0] focus-within:ring-2 focus-within:ring-[#315fc0]">
            <span className="text-[#8793a8]">Period</span>
            <select
              aria-label="Analytics period"
              value={range}
              onChange={(event) => setRange(event.target.value)}
              className="bg-transparent text-xs font-semibold text-[#344c77] outline-none"
            >
              <option>Last 30 Days</option>
              <option>Last 6 Months</option>
              <option>Year to Date</option>
            </select>
          </label>
          <button
            aria-label="Download synthetic analytics CSV"
            onClick={downloadSnapshot}
            className="grid h-9 w-9 place-items-center border border-[#bdc9dc] bg-[#f8f9fc] text-[#344c77] transition hover:border-[#315fc0] hover:bg-[#e9eef8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0]"
          >
            <Download size={15} />
          </button>
        </div>
      </div>

      {/* Main Stats */}
      <div className="grid gap-5 md:grid-cols-3 mb-5">
        <div className="border border-[#bdc9dc] bg-[#fbfcff] p-6">
          <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d] mb-2">Total Monthly Revenue</p>
          <div className="flex items-end gap-3">
            <h2 className="font-mono text-3xl font-semibold tracking-[-.05em] text-[#172c56]">
              ${displayedRevenue.toLocaleString()}
            </h2>
            <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-[#3156a2] bg-[#eef3fc] px-1.5 py-0.5">
              <ArrowUpRight size={14} />12.4%
            </span>
          </div>
          <div className="mt-6 space-y-2 border-t border-[#e4e8f0] pt-4">
            <div className="flex justify-between text-sm">
              <span className="text-[#53698f]">Recurring Subscriptions</span>
              <span className="font-mono font-medium text-[#172c56]">${displayedRecurringRevenue.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#53698f]">New Enrollments</span>
              <span className="font-mono font-medium text-[#172c56]">${displayedEnrollmentRevenue.toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="border border-[#bdc9dc] bg-[#fbfcff] p-6">
          <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d] mb-2">Demo Outcome Summary</p>
          <div className="flex items-end gap-3">
            <h2 className="font-mono text-3xl font-semibold tracking-[-.05em] text-[#172c56]">
              {MOCK_ANALYTICS.averageGoalCompletion}%
            </h2>
            <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-[#53698f]">Goal Completion</span>
          </div>
          <div className="mt-6 space-y-2 border-t border-[#e4e8f0] pt-4">
            <div className="flex justify-between text-sm">
              <span className="text-[#53698f]">Avg Weight Loss</span>
              <span className="font-mono font-medium text-[#172c56]">{MOCK_ANALYTICS.averagePoundsLost} lbs</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#53698f]">Protocol Retention</span>
              <span className="font-mono font-medium text-[#172c56]">{MOCK_ANALYTICS.retention}%</span>
            </div>
          </div>
        </div>

        <div className="border border-[#bdc9dc] bg-[#fbfcff] p-6 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMiIgY3k9IjIiIHI9IjEiIGZpbGw9IiNiZGM5ZGMiLz48L3N2Zz4=')] bg-[length:16px_16px]">
          <div className="bg-white/90 backdrop-blur-sm p-4 border border-[#e4e8f0] h-full flex flex-col justify-center text-center">
            <Target size={24} className="mx-auto text-[#315fc0] mb-3" />
            <h3 className="text-[#172c56] font-bold text-sm mb-1">Growth Opportunity</h3>
            <p className="text-xs text-[#53698f]">Maintenance stack conversions are up 14% this month. Recommend focusing on Week 5 cohort.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Cohort Table */}
        <div className="border border-[#bdc9dc] bg-[#fbfcff]">
          <div className="p-5 border-b border-[#bdc9dc] flex justify-between items-center bg-[#f8f9fc]">
            <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Cohort Outcomes</h2>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#e4e8f0] text-[10px] uppercase tracking-[.11em] text-[#8290a7]">
              <tr>
                <th className="px-5 py-3 font-semibold">Cohort Month</th>
                <th className="px-5 py-3 font-semibold">Avg Lbs Lost</th>
                <th className="px-5 py-3 font-semibold">Retention</th>
                <th className="px-5 py-3 font-semibold text-right">Performance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e4e8f0]">
              {MOCK_ANALYTICS.cohortOutcomes.map((cohort) => (
                <tr key={cohort.month} className="hover:bg-[#f0f3f9]">
                  <td className="px-5 py-4 font-semibold text-[#284675]">2024 - {cohort.month}</td>
                  <td className="px-5 py-4 font-mono text-[#53698f]">{cohort.avgLost}</td>
                  <td className="px-5 py-4 font-mono text-[#53698f]">{cohort.retention}%</td>
                  <td className="px-5 py-4 text-right">
                    <div className="w-24 h-1.5 bg-[#e4e9f2] ml-auto overflow-hidden">
                       <div className="h-full bg-[#315fc0]" style={{ width: `${cohort.retention}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Provider Performance */}
        <div className="border border-[#bdc9dc] bg-[#fbfcff]">
          <div className="p-5 border-b border-[#bdc9dc] flex justify-between items-center bg-[#f8f9fc]">
            <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Provider Outcomes</h2>
          </div>
          <div className="p-5 space-y-5">
            {MOCK_PROVIDERS.sort((a,b) => b.averageOutcomes - a.averageOutcomes).map(provider => (
              <div key={provider.id}>
                <div className="flex justify-between text-xs mb-2">
                  <span className="font-semibold text-[#172c56]">{provider.name}</span>
                  <span className="font-mono text-[#53698f]">{provider.averageOutcomes}% Avg Goal</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 bg-[#e4e9f2] overflow-hidden">
                    <div className="h-full bg-[#5576c2]" style={{ width: `${provider.averageOutcomes}%` }} />
                  </div>
                  <span className="text-[10px] text-[#8793a8] w-20 text-right">{provider.activePatientCount} patients</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

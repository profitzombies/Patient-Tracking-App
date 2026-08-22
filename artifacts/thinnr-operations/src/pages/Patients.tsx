import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Search, Filter, ArrowUpDown, ChevronRight } from "lucide-react";
import { MOCK_PATIENTS, MOCK_PROVIDERS, type Status } from "@/data/mock-data";

type SortField = 'name' | 'startDate' | 'status' | 'weightLoss';
type SortOrder = 'asc' | 'desc';

export default function Patients() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [sortField, setSortField] = useState<SortField>('startDate');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const filteredAndSortedPatients = useMemo(() => {
    let result = MOCK_PATIENTS.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) || 
                            p.email.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
      return matchesSearch && matchesStatus;
    });

    result.sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortField === 'startDate') {
        comparison = new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
      } else if (sortField === 'status') {
        comparison = a.status.localeCompare(b.status);
      } else if (sortField === 'weightLoss') {
        const aLoss = a.startingWeight - a.currentWeight;
        const bLoss = b.startingWeight - b.currentWeight;
        comparison = aLoss - bLoss;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [search, statusFilter, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc'); // Default to desc for dates/numbers mostly
    }
  };

  const getStatusColor = (status: Status) => {
    if (status === 'active' || status === 'graduated') return "bg-[#eef3fc] text-[#3156a2] border-[#aebfe0]";
    if (status === 'paused') return "bg-[#fff6e5] text-[#97631e] border-[#d7b889]";
    return "bg-[#fff0f0] text-[#a04646] border-[#d5a7a7]";
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[32px] leading-none tracking-[-.04em] text-[#172c56]">Patient Roster</h1>
          <p className="mt-2 text-sm text-[#718099]">Manage and monitor all THINNR protocol participants.</p>
        </div>
      </div>

      <div className="border border-[#bdc9dc] bg-[#fbfcff]">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-b border-[#bdc9dc] p-4 bg-[#f8f9fc]">
          <div className="relative w-full sm:w-80">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8793a8]" />
            <label htmlFor="patient-search" className="sr-only">Search patients by name or email</label>
            <input 
              id="patient-search"
              type="text" 
              placeholder="Search patients..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 border border-[#bdc9dc] bg-[#fbfcff] text-xs outline-none focus:border-[#315fc0] focus:ring-1 focus:ring-[#315fc0]"
            />
          </div>
          
          <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
            <div className="flex items-center text-xs font-semibold text-[#53698f]">
              <Filter size={14} className="mr-1.5" /> Filter by Status:
            </div>
            <select 
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as Status | 'all')}
              className="h-9 border border-[#bdc9dc] bg-[#fbfcff] px-2 text-xs text-[#1b2f55] outline-none focus:border-[#315fc0]"
            >
              <option value="all">All Patients</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="overdue">Overdue</option>
              <option value="graduated">Graduated (Maintenance)</option>
            </select>
            <select
              aria-label="Sort patients"
              value={`${sortField}-${sortOrder}`}
              onChange={(event) => {
                const [field, order] = event.target.value.split('-') as [SortField, SortOrder];
                setSortField(field);
                setSortOrder(order);
              }}
              className="h-9 border border-[#bdc9dc] bg-[#fbfcff] px-2 text-xs text-[#1b2f55] outline-none focus:border-[#315fc0] md:hidden"
            >
              <option value="startDate-desc">Newest start</option>
              <option value="name-asc">Name A–Z</option>
              <option value="weightLoss-desc">Most weight lost</option>
              <option value="status-asc">Status</option>
            </select>
          </div>
        </div>

        <div className="divide-y divide-[#e4e8f0] md:hidden">
          {filteredAndSortedPatients.map((patient) => {
            const provider = MOCK_PROVIDERS.find((candidate) => candidate.id === patient.providerId);
            const weightLoss = patient.startingWeight - patient.currentWeight;
            const percentLoss = ((weightLoss / patient.startingWeight) * 100).toFixed(1);
            return (
              <Link
                key={patient.id}
                href={`/patients/${patient.id}`}
                className="block p-4 transition-colors hover:bg-[#f0f3f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#315fc0]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center bg-[#dce6fa] text-[10px] font-bold text-[#3156a2]">{patient.initials}</span>
                    <div className="min-w-0">
                      <b className="block truncate text-sm text-[#172c56]">{patient.name}</b>
                      <span className="mt-0.5 block truncate text-[10px] text-[#7b879d]">{provider?.name}</span>
                    </div>
                  </div>
                  <span className={`inline-flex border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${getStatusColor(patient.status)}`}>
                    {patient.status}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Stage</p>
                    <p className="mt-1 text-[#53698f]">{patient.stage === 'protocol' ? `Week ${patient.protocolWeek}` : 'Maintenance'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Started</p>
                    <p className="mt-1 text-[#53698f]">{new Date(patient.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Progress</p>
                    <p className="mt-1 font-mono font-semibold text-[#284675]">{weightLoss.toFixed(1)} lbs</p>
                    <p className="text-[9px] text-[#8793a8]">{percentLoss}%</p>
                  </div>
                </div>
              </Link>
            );
          })}
          {filteredAndSortedPatients.length === 0 && (
            <div className="p-10 text-center text-xs text-[#7b879d]">No patients found matching your criteria.</div>
          )}
        </div>

        {/* Table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-xs min-w-[800px]">
            <thead className="border-b border-[#d5deeb] bg-[#f8f9fc] text-[10px] uppercase tracking-[.11em] text-[#8290a7]">
              <tr>
                <th className="px-4 py-3 font-semibold w-1/4">
                  <button onClick={() => handleSort('name')} className="flex items-center gap-1 hover:text-[#172c56]">
                    Patient {sortField === 'name' && <ArrowUpDown size={12} className="text-[#315fc0]" />}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold">
                  <button onClick={() => handleSort('status')} className="flex items-center gap-1 hover:text-[#172c56]">
                    Status {sortField === 'status' && <ArrowUpDown size={12} className="text-[#315fc0]" />}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold">Stage</th>
                <th className="px-4 py-3 font-semibold">Provider</th>
                <th className="px-4 py-3 font-semibold">
                  <button onClick={() => handleSort('startDate')} className="flex items-center gap-1 hover:text-[#172c56]">
                    Start Date {sortField === 'startDate' && <ArrowUpDown size={12} className="text-[#315fc0]" />}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold text-right">
                  <button onClick={() => handleSort('weightLoss')} className="flex items-center justify-end gap-1 w-full hover:text-[#172c56]">
                    Weight Loss {sortField === 'weightLoss' && <ArrowUpDown size={12} className="text-[#315fc0]" />}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedPatients.map((patient) => {
                const provider = MOCK_PROVIDERS.find(p => p.id === patient.providerId);
                const weightLoss = patient.startingWeight - patient.currentWeight;
                const percentLoss = ((weightLoss / patient.startingWeight) * 100).toFixed(1);
                
                return (
                  <tr key={patient.id} className="group border-b border-[#e4e8f0] last:border-0 hover:bg-[#f0f3f9] transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="grid h-8 w-8 shrink-0 place-items-center bg-[#dce6fa] text-[10px] font-bold text-[#3156a2]">
                          {patient.initials}
                        </span>
                        <div>
                          <b className="block text-[#172c56] font-semibold">{patient.name}</b>
                          <span className="text-[10px] text-[#7b879d]">{patient.email}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${getStatusColor(patient.status)}`}>
                        {patient.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[#53698f] capitalize">
                        {patient.stage === 'protocol' ? `Week ${patient.protocolWeek}` : 'Maintenance'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#53698f]">
                      {provider?.name.split(',')[0]}
                    </td>
                    <td className="px-4 py-3 text-[#53698f]">
                      {new Date(patient.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <b className="block text-[#284675]">{weightLoss.toFixed(1)} lbs</b>
                      <span className="text-[10px] text-[#8793a8]">{percentLoss}%</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/patients/${patient.id}`} className="inline-flex h-8 w-8 items-center justify-center text-[#8793a8] hover:text-[#315fc0] hover:bg-[#e9eef8] transition-colors">
                        <ChevronRight size={16} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
              
              {filteredAndSortedPatients.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-[#7b879d]">
                    No patients found matching your criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        
        {/* Pagination mock */}
        <div className="border-t border-[#bdc9dc] px-4 py-3 flex items-center justify-between text-xs text-[#7b879d] bg-[#fbfcff]">
          <span>Showing <b>{filteredAndSortedPatients.length}</b> records</span>
          <div className="flex gap-2">
            <button className="px-2 py-1 border border-[#bdc9dc] hover:bg-[#f0f3f9] disabled:opacity-50" disabled>Prev</button>
            <button className="px-2 py-1 border border-[#bdc9dc] hover:bg-[#f0f3f9] disabled:opacity-50" disabled>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}

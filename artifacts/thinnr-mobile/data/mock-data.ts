/**
 * Deterministic local mock data for THINNR Mobile Operations.
 * Mirrors artifacts/thinnr-operations/src/data/mock-data.ts
 * Uses native Date helpers instead of date-fns.
 */

export type Status = 'active' | 'paused' | 'overdue' | 'cancelled' | 'graduated';

export interface Patient {
  id: string;
  name: string;
  initials: string;
  email: string;
  phone: string;
  providerId: string;
  startDate: string;
  status: Status;
  protocolWeek: number;
  stage: 'protocol' | 'maintenance';
  startingWeight: number;
  currentWeight: number;
  goalWeight: number;
  adherence: number;
  nextCheckIn: string;
  products: string[];
  subscriptionId: string;
  revenue: number;
  notes: string[];
  activity: ActivityItem[];
  progressHistory: { date: string; weight: number }[];
  checkIns: { date: string; summary: string; mood: string }[];
}

export interface ActivityItem {
  id: string;
  date: string;
  type: string;
  description: string;
  user: string;
}

export interface Provider {
  id: string;
  name: string;
  role: string;
  activePatientCount: number;
  averageOutcomes: number;
}

export interface Product {
  id: string;
  name: string;
  category: 'drops' | 'supplement' | 'bundle';
  description: string;
  price: number;
  imageUrl: string;
  disclaimer?: string;
}

export interface Subscription {
  id: string;
  patientId: string;
  products: string[];
  status: 'active' | 'paused' | 'overdue' | 'cancelled';
  nextShipment: string;
  cadence: 'monthly' | 'quarterly';
  monthlyValue: number;
  paymentStatus: 'paid' | 'pending' | 'failed';
  shipmentHistory: { date: string; status: 'delivered' | 'shipped' | 'processing' }[];
}

// Native date helpers (no date-fns)
const today = new Date();

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function subDays(date: Date, days: number): Date {
  return addDays(date, -days);
}

function subMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() - months);
  return d;
}

const seededFraction = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

export const MOCK_PROVIDERS: Provider[] = [
  { id: 'p1', name: 'Dr. Sarah Jenkins', role: 'Medical Director', activePatientCount: 142, averageOutcomes: 88 },
  { id: 'p2', name: 'Michael Chen, NP', role: 'Lead Practitioner', activePatientCount: 185, averageOutcomes: 92 },
  { id: 'p3', name: 'Elena Rostova, RN', role: 'Protocol Coach', activePatientCount: 210, averageOutcomes: 85 },
  { id: 'p4', name: 'David Kim, NP', role: 'Practitioner', activePatientCount: 95, averageOutcomes: 81 },
];

export const MOCK_PRODUCTS: Product[] = [
  { id: 'prod1', name: 'Protocol', category: 'drops', description: 'Homeopathic OTC medication for weight-management support.*', price: 199, imageUrl: 'https://getthinnr.com/images/protocol.jpg', disclaimer: '*Claims follow traditional homeopathic principles and have not been evaluated by the FDA.' },
  { id: 'prod2', name: 'Boost', category: 'supplement', description: 'Helps support any weight-management program.*', price: 49, imageUrl: 'https://getthinnr.com/images/boost.jpg', disclaimer: '*Claims follow traditional homeopathic principles and have not been evaluated by the FDA.' },
  { id: 'prod3', name: 'Control', category: 'supplement', description: 'Helps support healthy appetite and metabolic function.**', price: 59, imageUrl: 'https://getthinnr.com/images/control.jpg', disclaimer: '**These statements have not been evaluated by the FDA.' },
  { id: 'prod4', name: 'Detox', category: 'supplement', description: 'Helps support liver health and digestive wellness.**', price: 45, imageUrl: 'https://getthinnr.com/images/detox.jpg', disclaimer: '**These statements have not been evaluated by the FDA.' },
  { id: 'prod5', name: 'Regulate', category: 'supplement', description: 'Helps support healthy glucose levels and metabolic function.**', price: 65, imageUrl: 'https://getthinnr.com/images/regulate.jpg', disclaimer: '**These statements have not been evaluated by the FDA.' },
  { id: 'prod6', name: 'B-Active', category: 'supplement', description: 'Multi-B with 5-MTHF for energy and wellness support.**', price: 39, imageUrl: 'https://getthinnr.com/images/b-active.jpg', disclaimer: '**These statements have not been evaluated by the FDA.' },
  { id: 'prod7', name: 'Creatine+', category: 'supplement', description: 'Creatine + HMB for muscle maintenance and cognitive support.**', price: 55, imageUrl: 'https://getthinnr.com/images/creatine-plus.jpg', disclaimer: '**These statements have not been evaluated by the FDA.' },
  { id: 'prod8', name: 'Fiber', category: 'supplement', description: 'Plant-based digestive support.**', price: 35, imageUrl: 'https://getthinnr.com/images/fiber.jpg', disclaimer: '**These statements have not been evaluated by the FDA.' },
  { id: 'prod9', name: 'Maintenance Stack', category: 'bundle', description: 'A bundled supplement stack for continued maintenance after the six-week protocol.**', price: 149, imageUrl: 'https://getthinnr.com/images/maintenance-stack.webp', disclaimer: '**These statements have not been evaluated by the FDA.' },
];

const generateName = (i: number): string => {
  const firsts = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia', 'James', 'Isabella', 'Oliver', 'Charlotte', 'Benjamin', 'Amelia', 'Elijah', 'Mia', 'Lucas', 'Harper', 'Mason', 'Evelyn', 'Logan', 'Abigail', 'Alexander', 'Emily', 'Ethan'];
  const lasts = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White'];
  return `${firsts[i % firsts.length]} ${lasts[(i * 3) % lasts.length]}`;
};

export const MOCK_PATIENTS: Patient[] = Array.from({ length: 32 }).map((_, i) => {
  const name = generateName(i);
  const initials = name.split(' ').map(n => n[0]).join('');
  const startWeight = 180 + (i * 7 % 100);
  const goalWeight = startWeight - 30 - (i % 20);
  const currentWeight = startWeight - (i * 3.5 % 35);
  const startDate = subDays(today, 10 + (i * 12)).toISOString();

  const history: { date: string; weight: number }[] = [];
  let w = startWeight;
  for (let j = 0; j < 6; j++) {
    w = w - (seededFraction((i + 1) * 100 + j) * 2 + 1);
    if (w < currentWeight) w = currentWeight;
    history.push({
      date: addDays(new Date(startDate), j * 7).toISOString(),
      weight: parseFloat(w.toFixed(1)),
    });
  }

  const isGraduated = i % 8 === 0;

  let status: Status = 'active';
  if (isGraduated) status = 'graduated';
  else if (i % 15 === 0) status = 'paused';
  else if (i % 12 === 0) status = 'overdue';

  const providerId = MOCK_PROVIDERS[i % MOCK_PROVIDERS.length].id;
  const isRisk = i % 7 === 0;

  return {
    id: `pat_${i + 100}`,
    name,
    initials,
    email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
    phone: `(555) ${Math.floor(200 + seededFraction(i + 40) * 800)}-${Math.floor(1000 + seededFraction(i + 80) * 9000)}`,
    providerId,
    startDate,
    status,
    protocolWeek: Math.min(6, Math.floor((new Date().getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24 * 7)) + 1),
    stage: isGraduated ? 'maintenance' : 'protocol',
    startingWeight: startWeight,
    currentWeight,
    goalWeight,
    adherence: isRisk ? 65 + Math.floor(seededFraction(i + 120) * 15) : 85 + Math.floor(seededFraction(i + 120) * 15),
    nextCheckIn: addDays(today, (i % 5) + 1).toISOString(),
    products: isGraduated ? ['prod9'] : ['prod1', i % 2 === 0 ? 'prod2' : 'prod3'],
    subscriptionId: `sub_${i + 100}`,
    revenue: 400 + (i * 150 % 1000),
    notes: [
      'Patient responding well to drops.',
      isRisk ? 'Missed last two check-ins.' : 'Energy levels reported as stable.',
    ],
    activity: [
      { id: `act_${i}_1`, date: subDays(today, 1).toISOString(), type: 'check_in', description: 'Weekly check-in completed', user: name },
      { id: `act_${i}_2`, date: subDays(today, 3).toISOString(), type: 'note', description: 'Added new dietary note', user: MOCK_PROVIDERS.find(p => p.id === providerId)?.name ?? 'System' },
    ],
    progressHistory: history,
    checkIns: [
      { date: subDays(today, 7).toISOString(), summary: 'Feeling good, slight cravings at night.', mood: 'positive' },
    ],
  };
});

export const MOCK_SUBSCRIPTIONS: Subscription[] = MOCK_PATIENTS.map((p, index) => ({
  id: p.subscriptionId,
  patientId: p.id,
  products: p.products,
  status: p.status === 'graduated' || p.status === 'active' ? 'active' : p.status === 'paused' ? 'paused' : 'overdue',
  nextShipment: addDays(today, Math.floor(seededFraction(index + 160) * 15) + 1).toISOString(),
  cadence: 'monthly' as const,
  monthlyValue: p.products.reduce((acc, curr) => acc + (MOCK_PRODUCTS.find(pr => pr.id === curr)?.price ?? 0), 0),
  paymentStatus: p.status === 'overdue' ? 'failed' : 'paid' as const,
  shipmentHistory: [
    { date: subMonths(today, 1).toISOString(), status: 'delivered' as const },
  ],
}));

export const MOCK_ANALYTICS = {
  monthlyRevenue: 184200,
  enrollmentRevenue: 62000,
  recurringRevenue: 122200,
  activePatients: 632,
  newEnrollments: 84,
  averagePoundsLost: 24.5,
  averageGoalCompletion: 88.2,
  retention: 94.5,
  cohortOutcomes: [
    { month: 'Jan', avgLost: 23.1, retention: 92 },
    { month: 'Feb', avgLost: 24.2, retention: 93 },
    { month: 'Mar', avgLost: 24.8, retention: 94 },
    { month: 'Apr', avgLost: 25.1, retention: 95 },
  ],
  stageCounts: {
    week1: 42,
    week2: 38,
    week3: 45,
    week4: 31,
    week5: 29,
    week6: 35,
    maintenance: 412,
  },
};

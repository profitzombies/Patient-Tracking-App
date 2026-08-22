import { addDays, subDays, subMonths } from 'date-fns';

export type Status = 'active' | 'paused' | 'overdue' | 'cancelled' | 'graduated';
export type Tone = 'healthy' | 'watch' | 'risk';

export interface WeightEntry {
  date: string;
  weight: number;
}

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
  progressHistory: WeightEntry[];
  checkIns: { date: string; summary: string; mood: string }[];
  carePlan: {
    name: string;
    focus: string;
    cadence: string;
    protocolStatus: string;
    nextMilestone: string;
  };
  adherenceDetail: {
    checkInRate: number;
    recentPattern: string;
    lastCheckIn: string;
  };
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
  averageOutcomes: number; // Avg % goal completion
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

// Fixed anchor — the same fictional "today" as the mobile companion app
// (artifacts/thinnr-mobile/data/mock-data.ts). Never use the viewer's clock:
// the demo dataset is a deterministic snapshot pinned to this date.
const today = new Date('2026-08-22T12:00:00.000Z');
const seededFraction = (seed: number) => {
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

const generateName = (i: number) => {
  const firsts = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia', 'James', 'Isabella', 'Oliver', 'Charlotte', 'Benjamin', 'Amelia', 'Elijah', 'Mia', 'Lucas', 'Harper', 'Mason', 'Evelyn', 'Logan', 'Abigail', 'Alexander', 'Emily', 'Ethan'];
  const lasts = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White'];
  return `${firsts[i % firsts.length]} ${lasts[(i * 3) % lasts.length]}`;
};

export const MOCK_PATIENTS: Patient[] = Array.from({ length: 32 }).map((_, i) => {
  const name = generateName(i);
  const initials = name.split(' ').map(n => n[0]).join('');
  const startWeight = 180 + (i * 7 % 100);
  const goalWeight = startWeight - 30 - (i % 20);
  const isGraduated = i % 8 === 0;
  const enrollmentDays = isGraduated
    ? 94 + (i * 17 % 168)
    : 13 + (i * 9 % 35);
  const startDate = subDays(today, enrollmentDays).toISOString();
  const totalGoalLoss = startWeight - goalWeight;
  const enrolledWeeks = enrollmentDays / 7;
  const protocolWeeklyLoss = 1.15 + seededFraction(i + 206) * 0.9;
  const expectedLoss = isGraduated
    ? protocolWeeklyLoss * 6 + Math.max(0, enrolledWeeks - 6) * (0.35 + seededFraction(i + 208) * 0.25)
    : protocolWeeklyLoss * enrolledWeeks;
  const currentWeight = parseFloat((startWeight - Math.min(totalGoalLoss * 0.92, expectedLoss)).toFixed(1));

  // Start with a true enrollment baseline, take weekly readings, and always end at
  // today's summary weight. Variation remains modest so the fictional trend reads
  // like a plausible monitored program rather than a perfectly straight line.
  const history: WeightEntry[] = [];
  const intervals = Math.max(1, Math.ceil(enrollmentDays / 7));
  for (let j = 0; j <= intervals; j++) {
    const isFinal = j === intervals;
    const elapsedDays = isFinal ? enrollmentDays : Math.min(j * 7, enrollmentDays);
    const progress = elapsedDays / enrollmentDays;
    const taper = isGraduated ? Math.pow(progress, 0.78) : Math.pow(progress, 0.91);
    const variation = j === 0 || isFinal ? 0 : (seededFraction(i * 41 + j) - 0.5) * 1.2;
    const weight = isFinal
      ? currentWeight
      : parseFloat(Math.max(currentWeight + 0.2, startWeight - (startWeight - currentWeight) * taper + variation).toFixed(1));
    history.push({
      date: addDays(new Date(startDate), elapsedDays).toISOString(),
      weight: j === 0 ? startWeight : weight,
    });
  }

  const isRisk = i % 7 === 0;
  
  let status: Status = 'active';
  if (isGraduated) status = 'graduated';
  else if (i % 15 === 0) status = 'paused';
  else if (i % 12 === 0) status = 'overdue';

  const providerId = MOCK_PROVIDERS[i % MOCK_PROVIDERS.length].id;
  
  const providerName = MOCK_PROVIDERS.find(p => p.id === providerId)?.name || 'Care team';
  const recentCheckInDays = Math.min(enrollmentDays - 1, 2 + (i % 6));
  const checkIns = [21, 12, recentCheckInDays]
    .filter((daysAgo, index, values) => daysAgo < enrollmentDays && values.indexOf(daysAgo) === index)
    .map((daysAgo, index) => ({
      date: subDays(today, daysAgo).toISOString(),
      summary: index === 0
        ? 'Reviewed routine and reported steady progress with the current plan.'
        : isRisk && index === 2
          ? 'Reported a busy week and requested a simple reset plan for the coming days.'
          : 'Check-in completed; energy and routine are stable with no new concerns noted.',
      mood: isRisk && index === 2 ? 'needs follow-up' : index === 1 ? 'neutral' : 'positive',
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const activity: ActivityItem[] = [
    {
      id: `act_${i}_1`,
      date: subDays(today, recentCheckInDays).toISOString(),
      type: 'check_in',
      description: 'Weekly check-in reviewed and care-plan status confirmed',
      user: name,
    },
    {
      id: `act_${i}_2`,
      date: subDays(today, Math.min(enrollmentDays - 1, recentCheckInDays + 3)).toISOString(),
      type: 'note',
      description: isRisk ? 'Care team noted a missed touchpoint and queued outreach.' : 'Care team documented routine and adherence update.',
      user: providerName,
    },
    {
      id: `act_${i}_3`,
      date: subDays(today, Math.min(enrollmentDays - 1, recentCheckInDays + 8)).toISOString(),
      type: 'fulfillment',
      description: 'Latest protocol order marked delivered.',
      user: 'THINNR fulfillment',
    },
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    id: `pat_${i + 100}`,
    name,
    initials,
    email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
    phone: `(555) ${Math.floor(200 + seededFraction(i + 40) * 800)}-${Math.floor(1000 + seededFraction(i + 80) * 9000)}`,
    providerId,
    startDate,
    status,
    protocolWeek: Math.min(6, Math.floor(enrollmentDays / 7) + 1),
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
      isRisk ? 'Outreach is planned after the most recent missed touchpoint.' : 'Patient reports the current routine is manageable.',
      isGraduated ? 'Maintenance routines reviewed at the last scheduled check-in.' : 'Care team will revisit progress at the next check-in.',
    ],
    activity,
    progressHistory: history,
    checkIns,
    carePlan: {
      name: isGraduated ? 'THINNR Maintenance Plan' : 'THINNR Six-Week Protocol',
      focus: isGraduated ? 'Maintain routines and monitor long-term progress.' : i % 3 === 0 ? 'Build a predictable daily routine and regular check-ins.' : 'Support consistent protocol routines and weekly reflection.',
      cadence: isGraduated ? 'Monthly care review' : 'Weekly check-in',
      protocolStatus: isRisk ? 'Needs outreach' : isGraduated ? 'Maintenance monitoring' : `Week ${Math.min(6, Math.floor(enrollmentDays / 7) + 1)} in progress`,
      nextMilestone: isGraduated ? 'Review maintenance routine' : `Complete week ${Math.min(6, Math.floor(enrollmentDays / 7) + 1)} check-in`,
    },
    adherenceDetail: {
      checkInRate: isRisk ? 67 : 83 + Math.floor(seededFraction(i + 260) * 17),
      recentPattern: isRisk ? 'One recent touchpoint needs follow-up.' : 'Recent check-ins and routine tracking are on track.',
      lastCheckIn: checkIns[0]?.date ?? startDate,
    },
  };
});

export const MOCK_SUBSCRIPTIONS: Subscription[] = MOCK_PATIENTS.map((p, index) => {
  const enrollmentDays = Math.max(1, Math.floor((today.getTime() - new Date(p.startDate).getTime()) / 86_400_000));
  const deliveryOffsets = enrollmentDays > 42
    ? [8 + (index % 5), 36 + (index % 6)]
    : [Math.min(enrollmentDays - 1, 5 + (index % 5))];

  return {
    id: p.subscriptionId,
    patientId: p.id,
    products: p.products,
    status: p.status === 'graduated' || p.status === 'active' ? 'active' : p.status === 'paused' ? 'paused' : p.status === 'cancelled' ? 'cancelled' : 'overdue',
    nextShipment: addDays(today, Math.floor(seededFraction(index + 160) * 15) + 1).toISOString(),
    cadence: 'monthly',
    monthlyValue: p.products.reduce((acc, curr) => acc + (MOCK_PRODUCTS.find(pr => pr.id === curr)?.price || 0), 0),
    paymentStatus: p.status === 'overdue' ? 'failed' : 'paid',
    shipmentHistory: deliveryOffsets.map((daysAgo) => ({
      date: subDays(today, Math.min(enrollmentDays - 1, daysAgo)).toISOString(),
      status: 'delivered' as const,
    })),
  };
});

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
    maintenance: 412
  }
};

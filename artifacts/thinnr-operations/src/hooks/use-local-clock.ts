import { useEffect, useState } from 'react';
import { timeOfDayGreeting, type TimeOfDayGreeting } from '@/lib/local-time';

/**
 * The device-local salutation, re-evaluated every minute so a dashboard left
 * open across noon or 5 PM flips without a reload. Live surfaces only — the
 * demo keeps its fixed "Good morning".
 */
export function useTimeOfDayGreeting(): TimeOfDayGreeting {
  const [greeting, setGreeting] = useState<TimeOfDayGreeting>(() => timeOfDayGreeting());
  useEffect(() => {
    const id = window.setInterval(() => setGreeting(timeOfDayGreeting()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return greeting;
}

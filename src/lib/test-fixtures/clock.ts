import { systemClock, type Clock } from "../store/types";

// Fixtures mode only: an offset added to the server clock, so a browser test can move the
// server across a UTC midnight. Production never reads it (getServerDeps uses systemClock).
let offsetMs = 0;

export function setFixtureClockOffset(ms: number): void {
  offsetMs = ms;
}

export const fixtureClock: Clock = () => systemClock() + offsetMs;

export type InclinePercent = 0 | 5;

export type Profile = {
  weightKg: number | null;
  inclinePercent: InclinePercent;
};

export type SessionSnapshot = {
  deviceElapsedSeconds: number | null;
  deviceDistanceM: number | null;
  baselineElapsedSeconds: number;
  baselineDistanceM: number;
  reportedAverageSpeedKmh: number | null;
  lastUpdatedAtMs: number | null;
  pendingElapsedResetFrom?: number | null;
  pendingDistanceResetFrom?: number | null;
};

export type SessionHistoryEntry = {
  id: string;
  endedAtMs: number;
  durationSeconds: number;
  distanceM: number;
  averageSpeedKmh: number;
  activeCalories: number | null;
  weightKg: number | null;
  inclinePercent: InclinePercent;
};

export type SessionTelemetry = {
  elapsed_seconds: number | null;
  total_distance_m: number | null;
  average_speed_kmh: number | null;
};

export type AppliedSessionTelemetry = {
  session: SessionSnapshot;
  history: SessionHistoryEntry[];
  archived: boolean;
};

export const PROFILE_STORAGE_KEY = "kalwol.profile.v1";
export const SESSION_STORAGE_KEY = "kalwol.session.v1";
export const HISTORY_STORAGE_KEY = "kalwol.history.v1";
export const FORECAST_HOURS = [1, 2, 3, 4] as const;

export const EMPTY_PROFILE: Profile = { weightKg: null, inclinePercent: 0 };
export const EMPTY_SESSION: SessionSnapshot = {
  deviceElapsedSeconds: null,
  deviceDistanceM: null,
  baselineElapsedSeconds: 0,
  baselineDistanceM: 0,
  reportedAverageSpeedKmh: null,
  lastUpdatedAtMs: null,
  pendingElapsedResetFrom: null,
  pendingDistanceResetFrom: null,
};

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function parseProfile(raw: string | null): Profile {
  if (!raw) return { ...EMPTY_PROFILE };
  try {
    const value = JSON.parse(raw) as Partial<Omit<Profile, "inclinePercent">> & {
      inclinePercent?: number;
    };
    return {
      weightKg: finiteInRange(value.weightKg, 30, 250) ? value.weightKg : null,
      inclinePercent: value.inclinePercent === 5 || value.inclinePercent === 10 ? 5 : 0,
    };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export function parseSession(raw: string | null): SessionSnapshot {
  if (!raw) return { ...EMPTY_SESSION };
  try {
    const value = JSON.parse(raw) as Partial<SessionSnapshot> & {
      elapsedSeconds?: number;
      totalDistanceM?: number;
    };
    const deviceElapsed = value.deviceElapsedSeconds ?? value.elapsedSeconds;
    const deviceDistance = value.deviceDistanceM ?? value.totalDistanceM;
    return {
      deviceElapsedSeconds: finiteInRange(deviceElapsed, 0, 65_535) ? deviceElapsed : null,
      deviceDistanceM: finiteInRange(deviceDistance, 0, 16_777_215) ? deviceDistance : null,
      baselineElapsedSeconds: finiteInRange(value.baselineElapsedSeconds, 0, 65_535)
        ? value.baselineElapsedSeconds
        : 0,
      baselineDistanceM: finiteInRange(value.baselineDistanceM, 0, 16_777_215)
        ? value.baselineDistanceM
        : 0,
      reportedAverageSpeedKmh: finiteInRange(value.reportedAverageSpeedKmh, 0, 20)
        ? value.reportedAverageSpeedKmh
        : null,
      lastUpdatedAtMs: finiteInRange(value.lastUpdatedAtMs, 0, Number.MAX_SAFE_INTEGER)
        ? value.lastUpdatedAtMs
        : null,
      pendingElapsedResetFrom: finiteInRange(value.pendingElapsedResetFrom, 0, 65_535)
        ? value.pendingElapsedResetFrom
        : null,
      pendingDistanceResetFrom: finiteInRange(value.pendingDistanceResetFrom, 0, 16_777_215)
        ? value.pendingDistanceResetFrom
        : null,
    };
  } catch {
    return { ...EMPTY_SESSION };
  }
}

export function updateSession(
  previous: SessionSnapshot,
  telemetry: SessionTelemetry,
  receivedAtMs = Date.now(),
): SessionSnapshot {
  const rawElapsed = finiteInRange(telemetry.elapsed_seconds, 0, 65_535)
    ? telemetry.elapsed_seconds
    : null;
  const rawDistance = finiteInRange(telemetry.total_distance_m, 0, 16_777_215)
    ? telemetry.total_distance_m
    : null;
  const pendingElapsed = previous.pendingElapsedResetFrom ?? null;
  const pendingDistance = previous.pendingDistanceResetFrom ?? null;
  const elapsed = pendingElapsed !== null && !(rawElapsed !== null && rawElapsed < pendingElapsed)
    ? null
    : rawElapsed;
  const distance = pendingDistance !== null && !(rawDistance !== null && rawDistance < pendingDistance)
    ? null
    : rawDistance;
  const reportedAverage = finiteInRange(telemetry.average_speed_kmh, 0, 20)
    ? telemetry.average_speed_kmh
    : null;
  const reset =
    (elapsed !== null && previous.deviceElapsedSeconds !== null && elapsed < previous.deviceElapsedSeconds) ||
    (distance !== null && previous.deviceDistanceM !== null && distance < previous.deviceDistanceM);
  const countersChanged =
    (elapsed !== null && elapsed !== previous.deviceElapsedSeconds) ||
    (distance !== null && distance !== previous.deviceDistanceM);

  if (reset) {
    return {
      deviceElapsedSeconds: elapsed,
      deviceDistanceM: distance,
      baselineElapsedSeconds: 0,
      baselineDistanceM: 0,
      reportedAverageSpeedKmh: reportedAverage,
      lastUpdatedAtMs: receivedAtMs,
      pendingElapsedResetFrom: null,
      pendingDistanceResetFrom: null,
    };
  }
  return {
    deviceElapsedSeconds: elapsed ?? previous.deviceElapsedSeconds,
    deviceDistanceM: distance ?? previous.deviceDistanceM,
    baselineElapsedSeconds: previous.baselineElapsedSeconds,
    baselineDistanceM: previous.baselineDistanceM,
    reportedAverageSpeedKmh: reportedAverage ?? previous.reportedAverageSpeedKmh,
    lastUpdatedAtMs: countersChanged ? receivedAtMs : previous.lastUpdatedAtMs,
    pendingElapsedResetFrom: pendingElapsed !== null && elapsed === null ? pendingElapsed : null,
    pendingDistanceResetFrom: pendingDistance !== null && distance === null ? pendingDistance : null,
  };
}

export function hasCounterReset(previous: SessionSnapshot, telemetry: SessionTelemetry): boolean {
  return (
    ((previous.pendingElapsedResetFrom ?? null) === null &&
      finiteInRange(telemetry.elapsed_seconds, 0, 65_535) &&
      previous.deviceElapsedSeconds !== null &&
      telemetry.elapsed_seconds < previous.deviceElapsedSeconds) ||
    ((previous.pendingDistanceResetFrom ?? null) === null &&
      finiteInRange(telemetry.total_distance_m, 0, 16_777_215) &&
      previous.deviceDistanceM !== null &&
      telemetry.total_distance_m < previous.deviceDistanceM)
  );
}

function sameLocalDay(firstMs: number, secondMs: number): boolean {
  const first = new Date(firstMs);
  const second = new Date(secondMs);
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

function startSessionAfterCounterReset(
  previous: SessionSnapshot,
  telemetry: SessionTelemetry,
  receivedAtMs: number,
): SessionSnapshot {
  const elapsed = finiteInRange(telemetry.elapsed_seconds, 0, 65_535)
    ? telemetry.elapsed_seconds
    : null;
  const distance = finiteInRange(telemetry.total_distance_m, 0, 16_777_215)
    ? telemetry.total_distance_m
    : null;
  const elapsedReset = elapsed !== null
    && previous.deviceElapsedSeconds !== null
    && elapsed < previous.deviceElapsedSeconds;
  const distanceReset = distance !== null
    && previous.deviceDistanceM !== null
    && distance < previous.deviceDistanceM;
  return {
    deviceElapsedSeconds: elapsedReset ? elapsed : null,
    deviceDistanceM: distanceReset ? distance : null,
    baselineElapsedSeconds: 0,
    baselineDistanceM: 0,
    reportedAverageSpeedKmh: finiteInRange(telemetry.average_speed_kmh, 0, 20)
      ? telemetry.average_speed_kmh
      : null,
    lastUpdatedAtMs: receivedAtMs,
    pendingElapsedResetFrom: elapsedReset ? null : previous.deviceElapsedSeconds,
    pendingDistanceResetFrom: distanceReset ? null : previous.deviceDistanceM,
  };
}

export function resetSession(session: SessionSnapshot): SessionSnapshot {
  return {
    ...session,
    baselineElapsedSeconds: session.deviceElapsedSeconds ?? 0,
    baselineDistanceM: session.deviceDistanceM ?? 0,
    reportedAverageSpeedKmh: null,
  };
}

export function sessionElapsedSeconds(session: SessionSnapshot): number | null {
  if (session.deviceElapsedSeconds === null) return null;
  return Math.max(0, session.deviceElapsedSeconds - session.baselineElapsedSeconds);
}

export function sessionDistanceM(session: SessionSnapshot): number | null {
  if (session.deviceDistanceM === null) return null;
  return Math.max(0, session.deviceDistanceM - session.baselineDistanceM);
}

export function averageSpeedKmh(session: SessionSnapshot): number | null {
  const elapsed = sessionElapsedSeconds(session);
  const distance = sessionDistanceM(session);
  if (elapsed === 0 && distance === 0) return 0;
  if (elapsed !== null && elapsed > 0 && distance !== null) {
    return (distance * 3.6) / elapsed;
  }
  return session.baselineElapsedSeconds === 0 ? session.reportedAverageSpeedKmh : null;
}

export function estimateCalories(
  weightKg: number | null,
  averageKmh: number | null,
  elapsedSeconds: number | null,
  inclinePercent: InclinePercent,
): number | null {
  if (!finiteInRange(weightKg, 30, 250)) return null;
  if (!finiteInRange(averageKmh, 0, 20) || !finiteInRange(elapsedSeconds, 0, 65_535)) return null;
  if (averageKmh === 0 || elapsedSeconds === 0) return 0;

  const metresPerMinute = (averageKmh * 1000) / 60;
  const grade = inclinePercent / 100;
  const activeOxygenMlKgMin = averageKmh < 8
    ? 0.1 * metresPerMinute + 1.8 * metresPerMinute * grade
    : 0.2 * metresPerMinute + 0.9 * metresPerMinute * grade;
  return activeOxygenMlKgMin * weightKg * 0.005 * (elapsedSeconds / 60);
}

export function calorieForecast(
  weightKg: number | null,
  averageKmh: number | null,
  inclinePercent: InclinePercent,
) {
  return FORECAST_HOURS.map((hours) => ({
    hours,
    calories: estimateCalories(weightKg, averageKmh, hours * 3600, inclinePercent),
  }));
}

function parseHistoryEntry(value: unknown): SessionHistoryEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<Omit<SessionHistoryEntry, "inclinePercent">> & {
    inclinePercent?: number;
  };
  const valid = (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    entry.id.length <= 128 &&
    finiteInRange(entry.endedAtMs, 0, Number.MAX_SAFE_INTEGER) &&
    finiteInRange(entry.durationSeconds, 1, 65_535) &&
    finiteInRange(entry.distanceM, 0, 16_777_215) &&
    finiteInRange(entry.averageSpeedKmh, 0, 20) &&
    (entry.activeCalories === null || finiteInRange(entry.activeCalories, 0, 100_000)) &&
    (entry.weightKg === null || finiteInRange(entry.weightKg, 30, 250)) &&
    (entry.inclinePercent === 0 || entry.inclinePercent === 5 || entry.inclinePercent === 10)
  );
  if (!valid) return null;

  const inclinePercent: InclinePercent = entry.inclinePercent === 0 ? 0 : 5;
  return {
    id: entry.id!,
    endedAtMs: entry.endedAtMs!,
    durationSeconds: entry.durationSeconds!,
    distanceM: entry.distanceM!,
    averageSpeedKmh: entry.averageSpeedKmh!,
    activeCalories: entry.inclinePercent === 10
      ? estimateCalories(
        entry.weightKg ?? null,
        entry.averageSpeedKmh!,
        entry.durationSeconds!,
        inclinePercent,
      )
      : entry.activeCalories!,
    weightKg: entry.weightKg!,
    inclinePercent,
  };
}

export function parseHistory(raw: string | null): SessionHistoryEntry[] {
  if (!raw) return [];
  if (raw.length > 1_000_000) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return pruneHistory(
      value
        .map(parseHistoryEntry)
        .filter((entry): entry is SessionHistoryEntry => entry !== null),
    );
  } catch {
    return [];
  }
}

export function createHistoryEntry(
  session: SessionSnapshot,
  profile: Profile,
  fallbackEndedAtMs: number | null = null,
): SessionHistoryEntry | null {
  const durationSeconds = sessionElapsedSeconds(session);
  const distanceM = sessionDistanceM(session);
  const average = averageSpeedKmh(session);
  if (durationSeconds === null || durationSeconds <= 0 || distanceM === null || average === null) {
    return null;
  }
  const endedAtMs = session.lastUpdatedAtMs ?? fallbackEndedAtMs;
  if (endedAtMs === null) return null;
  return {
    id: `${endedAtMs}-${durationSeconds}-${distanceM}`,
    endedAtMs,
    durationSeconds,
    distanceM,
    averageSpeedKmh: average,
    activeCalories: estimateCalories(profile.weightKg, average, durationSeconds, profile.inclinePercent),
    weightKg: profile.weightKg,
    inclinePercent: profile.inclinePercent,
  };
}

export function appendHistory(
  history: SessionHistoryEntry[],
  entry: SessionHistoryEntry,
  nowMs = Date.now(),
): SessionHistoryEntry[] {
  return pruneHistory([entry, ...history], nowMs);
}

export function pruneHistory(
  history: SessionHistoryEntry[],
  nowMs = Date.now(),
): SessionHistoryEntry[] {
  const oldestAllowed = nowMs - 31 * 24 * 60 * 60 * 1000;
  return history
    .filter((item, index, values) =>
      item.endedAtMs >= oldestAllowed && values.findIndex(({ id }) => id === item.id) === index)
    .sort((a, b) => b.endedAtMs - a.endedAtMs)
    .slice(0, 200);
}

export function applySessionTelemetry(
  previous: SessionSnapshot,
  history: SessionHistoryEntry[],
  profile: Profile,
  telemetry: SessionTelemetry,
  receivedAtMs = Date.now(),
): AppliedSessionTelemetry {
  const crossedMidnight = previous.lastUpdatedAtMs !== null
    && !sameLocalDay(previous.lastUpdatedAtMs, receivedAtMs);
  const reset = hasCounterReset(previous, telemetry);
  let current = previous;
  let nextHistory = history;
  let archived = false;

  if (crossedMidnight || reset) {
    const entry = createHistoryEntry(previous, profile, previous.lastUpdatedAtMs ?? receivedAtMs);
    if (entry) {
      nextHistory = appendHistory(history, entry, receivedAtMs);
      archived = true;
    }
    current = crossedMidnight ? resetSession(previous) : previous;
  }

  return {
    session: reset
      ? startSessionAfterCounterReset(current, telemetry, receivedAtMs)
      : updateSession(current, telemetry, receivedAtMs),
    history: nextHistory,
    archived,
  };
}

export function historyForLocalDay(
  history: SessionHistoryEntry[],
  day = new Date(),
): SessionHistoryEntry[] {
  return history.filter(({ endedAtMs }) => {
    const ended = new Date(endedAtMs);
    return ended.getFullYear() === day.getFullYear()
      && ended.getMonth() === day.getMonth()
      && ended.getDate() === day.getDate();
  });
}

export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null) return "--:--";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

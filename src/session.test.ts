import { describe, expect, it } from "vitest";
import {
  EMPTY_SESSION,
  applySessionTelemetry,
  appendHistory,
  averageSpeedKmh,
  calorieForecast,
  createHistoryEntry,
  estimateCalories,
  hasCounterReset,
  historyForLocalDay,
  parseHistory,
  parseProfile,
  parseSession,
  pruneHistory,
  resetSession,
  sessionDistanceM,
  sessionElapsedSeconds,
  updateSession,
} from "./session";

describe("session metrics", () => {
  it("derives the observed session average from distance and elapsed time", () => {
    const session = updateSession(EMPTY_SESSION, {
      elapsed_seconds: 1047,
      total_distance_m: 1304,
      average_speed_kmh: null,
    });
    expect(averageSpeedKmh(session)).toBeCloseTo(4.484, 3);
  });

  it("does not inflate counters when the same snapshot is received twice", () => {
    const telemetry = { elapsed_seconds: 1047, total_distance_m: 1304, average_speed_kmh: null };
    const once = updateSession(EMPTY_SESSION, telemetry);
    expect(updateSession(once, telemetry)).toEqual(once);
  });

  it("starts a new session when the treadmill counters roll back", () => {
    const previous = {
      deviceElapsedSeconds: 1047,
      deviceDistanceM: 1304,
      baselineElapsedSeconds: 0,
      baselineDistanceM: 0,
      reportedAverageSpeedKmh: null,
      lastUpdatedAtMs: 1000,
    };
    expect(updateSession(previous, {
      elapsed_seconds: 12,
      total_distance_m: 8,
      average_speed_kmh: null,
    }, 2000)).toEqual({
      deviceElapsedSeconds: 12,
      deviceDistanceM: 8,
      baselineElapsedSeconds: 0,
      baselineDistanceM: 0,
      reportedAverageSpeedKmh: null,
      lastUpdatedAtMs: 2000,
      pendingElapsedResetFrom: null,
      pendingDistanceResetFrom: null,
    });
  });

  it("uses a persisted baseline for an app-defined session", () => {
    const baseline = resetSession(updateSession(EMPTY_SESSION, {
      elapsed_seconds: 1047,
      total_distance_m: 1304,
      average_speed_kmh: null,
    }));
    const current = updateSession(baseline, {
      elapsed_seconds: 3719,
      total_distance_m: 4645,
      average_speed_kmh: null,
    });
    expect(sessionElapsedSeconds(current)).toBe(2672);
    expect(sessionDistanceM(current)).toBe(3341);
    expect(averageSpeedKmh(current)).toBeCloseTo(4.501, 3);
  });

  it("estimates more calories for the five-percent incline", () => {
    const flat = estimateCalories(70, 4.484, 1047, 0)!;
    const inclined = estimateCalories(70, 4.484, 1047, 5)!;
    expect(flat).toBeCloseTo(45.64, 2);
    expect(inclined).toBeCloseTo(86.72, 2);
    expect(inclined).toBeGreaterThan(flat);
  });

  it("excludes resting calories from the running equation", () => {
    expect(estimateCalories(70, 10, 3600, 0)).toBeCloseTo(700, 0);
  });

  it("keeps zero-speed and zero-duration sessions at zero active calories", () => {
    expect(estimateCalories(70, 0, 3600, 5)).toBe(0);
    expect(estimateCalories(70, 4.5, 0, 5)).toBe(0);
  });

  it("projects active calories from one to four hours", () => {
    const forecast = calorieForecast(103, 4.16, 5);
    expect(forecast.map(({ hours }) => hours)).toEqual([1, 2, 3, 4]);
    expect(forecast[0].calories).toBeCloseTo(407.06, 2);
    expect(forecast[1].calories).toBeCloseTo(forecast[0].calories! * 2, 8);
    expect(forecast[3].calories).toBeCloseTo(forecast[0].calories! * 4, 8);
  });

  it("cannot forecast without weight or an observed average", () => {
    expect(calorieForecast(null, 4.16, 5).every(({ calories }) => calories === null)).toBe(true);
    expect(calorieForecast(103, null, 5).every(({ calories }) => calories === null)).toBe(true);
  });

  it("uses a reported average when elapsed time is unavailable", () => {
    const average = averageSpeedKmh({
      ...EMPTY_SESSION,
      reportedAverageSpeedKmh: 4.5,
    });
    expect(calorieForecast(103, average, 5)[0].calories).not.toBeNull();
  });

  it("projects fewer active calories for the same walk when flat", () => {
    const flat = calorieForecast(103, 4.16, 0)[0].calories!;
    const inclined = calorieForecast(103, 4.16, 5)[0].calories!;
    expect(flat).toBeCloseTo(214.24, 2);
    expect(inclined).toBeGreaterThan(flat);
  });

  it("rejects corrupt or unsafe persisted settings", () => {
    expect(parseProfile('{"weightKg":999,"inclinePercent":7}')).toEqual({
      weightKg: null,
      inclinePercent: 0,
    });
    expect(parseProfile('{"weightKg":70,"inclinePercent":10}')).toEqual({
      weightKg: 70,
      inclinePercent: 5,
    });
    expect(parseSession("not json")).toEqual(EMPTY_SESSION);
    expect(parseHistory('{"bad":true}')).toEqual([]);
    expect(parseHistory(" ".repeat(1_000_001))).toEqual([]);
  });

  it("migrates legacy ten-percent history and recalculates its calories", () => {
    const legacy = {
      id: "legacy-ten-percent",
      endedAtMs: Date.now(),
      durationSeconds: 3600,
      distanceM: 4160,
      averageSpeedKmh: 4.16,
      activeCalories: 599.87,
      weightKg: 103,
      inclinePercent: 10,
    };
    const [migrated] = parseHistory(JSON.stringify([legacy]));
    expect(migrated.inclinePercent).toBe(5);
    expect(migrated.activeCalories).toBeCloseTo(407.06, 2);
  });

  it("does not assign a legacy session with no observation timestamp to today", () => {
    expect(createHistoryEntry({
      deviceElapsedSeconds: 600,
      deviceDistanceM: 750,
      baselineElapsedSeconds: 0,
      baselineDistanceM: 0,
      reportedAverageSpeedKmh: null,
      lastUpdatedAtMs: null,
    }, { weightKg: 70, inclinePercent: 0 })).toBeNull();
  });

  it("detects a treadmill reset and archives the completed session", () => {
    const completed = {
      deviceElapsedSeconds: 5998,
      deviceDistanceM: 7546,
      baselineElapsedSeconds: 1062,
      baselineDistanceM: 1683,
      reportedAverageSpeedKmh: null,
      lastUpdatedAtMs: Date.UTC(2026, 8, 14, 9, 22, 18),
    };
    expect(hasCounterReset(completed, {
      elapsed_seconds: 151,
      total_distance_m: 204,
      average_speed_kmh: null,
    })).toBe(true);
    const entry = createHistoryEntry(completed, { weightKg: 103, inclinePercent: 5 })!;
    expect(entry.durationSeconds).toBe(4936);
    expect(entry.distanceM).toBe(5863);
    expect(entry.averageSpeedKmh).toBeCloseTo(4.276, 3);
    expect(entry.activeCalories).toBeCloseTo(574, 0);
  });

  it("deduplicates history and selects sessions by local day", () => {
    const entry = createHistoryEntry({
      deviceElapsedSeconds: 3600,
      deviceDistanceM: 4500,
      baselineElapsedSeconds: 0,
      baselineDistanceM: 0,
      reportedAverageSpeedKmh: null,
      lastUpdatedAtMs: new Date(2026, 8, 14, 12).getTime(),
    }, { weightKg: 70, inclinePercent: 0 })!;
    const history = appendHistory([entry], entry, new Date(2026, 8, 14, 13).getTime());
    expect(history).toHaveLength(1);
    expect(historyForLocalDay(history, new Date(2026, 8, 14))).toEqual([entry]);
    expect(historyForLocalDay(history, new Date(2026, 8, 15))).toEqual([]);
  });

  it("prunes history older than 31 days even without a new archive", () => {
    const now = new Date(2026, 8, 14, 12).getTime();
    const recent = createHistoryEntry({
      deviceElapsedSeconds: 600,
      deviceDistanceM: 750,
      baselineElapsedSeconds: 0,
      baselineDistanceM: 0,
      reportedAverageSpeedKmh: null,
      lastUpdatedAtMs: now - 30 * 24 * 60 * 60 * 1000,
    }, { weightKg: 70, inclinePercent: 0 })!;
    const expired = { ...recent, id: "expired", endedAtMs: now - 32 * 24 * 60 * 60 * 1000 };
    expect(pruneHistory([recent, expired], now)).toEqual([recent]);
  });

  it("atomically prepares an archive before starting from reset counters", () => {
    const previous = {
      deviceElapsedSeconds: 5998,
      deviceDistanceM: 7546,
      baselineElapsedSeconds: 1062,
      baselineDistanceM: 1683,
      reportedAverageSpeedKmh: null,
      lastUpdatedAtMs: new Date(2026, 8, 14, 11, 22).getTime(),
    };
    const applied = applySessionTelemetry(
      previous,
      [],
      { weightKg: 103, inclinePercent: 5 },
      { elapsed_seconds: 151, total_distance_m: 204, average_speed_kmh: null },
      new Date(2026, 8, 14, 11, 25).getTime(),
    );

    expect(applied.archived).toBe(true);
    expect(applied.history).toHaveLength(1);
    expect(applied.history[0]).toMatchObject({ durationSeconds: 4936, distanceM: 5863 });
    expect(applied.session).toMatchObject({
      deviceElapsedSeconds: 151,
      deviceDistanceM: 204,
      baselineElapsedSeconds: 0,
      baselineDistanceM: 0,
    });
    expect(parseHistory(JSON.stringify(applied.history))).toEqual(applied.history);
  });

  it("coalesces elapsed and distance counters that reset in separate packets", () => {
    const previous = {
      deviceElapsedSeconds: 4800,
      deviceDistanceM: 6000,
      baselineElapsedSeconds: 0,
      baselineDistanceM: 0,
      reportedAverageSpeedKmh: null,
      lastUpdatedAtMs: new Date(2026, 8, 14, 12).getTime(),
    };
    const first = applySessionTelemetry(
      previous,
      [],
      { weightKg: 70, inclinePercent: 0 },
      { elapsed_seconds: 2, total_distance_m: 6000, average_speed_kmh: null },
      new Date(2026, 8, 14, 12, 1).getTime(),
    );
    expect(first.history).toHaveLength(1);
    expect(first.session.deviceDistanceM).toBeNull();

    const replay = applySessionTelemetry(
      first.session,
      first.history,
      { weightKg: 70, inclinePercent: 0 },
      { elapsed_seconds: 2, total_distance_m: 6000, average_speed_kmh: null },
      new Date(2026, 8, 14, 12, 1, 0, 500).getTime(),
    );
    expect(replay.history).toHaveLength(1);
    expect(replay.session.deviceDistanceM).toBeNull();

    const second = applySessionTelemetry(
      replay.session,
      replay.history,
      { weightKg: 70, inclinePercent: 0 },
      { elapsed_seconds: 3, total_distance_m: 4, average_speed_kmh: null },
      new Date(2026, 8, 14, 12, 1, 1).getTime(),
    );
    expect(second.archived).toBe(false);
    expect(second.history).toHaveLength(1);
    expect(second.session.deviceDistanceM).toBe(4);
  });

  it("archives at local midnight so daily totals do not move to the next day", () => {
    const beforeMidnight = new Date(2026, 8, 14, 23, 59, 59).getTime();
    const afterMidnight = new Date(2026, 8, 15, 0, 0, 1).getTime();
    const applied = applySessionTelemetry(
      {
        deviceElapsedSeconds: 3600,
        deviceDistanceM: 4500,
        baselineElapsedSeconds: 0,
        baselineDistanceM: 0,
        reportedAverageSpeedKmh: null,
        lastUpdatedAtMs: beforeMidnight,
      },
      [],
      { weightKg: 70, inclinePercent: 0 },
      { elapsed_seconds: 3602, total_distance_m: 4503, average_speed_kmh: null },
      afterMidnight,
    );

    expect(historyForLocalDay(applied.history, new Date(2026, 8, 14))).toHaveLength(1);
    expect(sessionElapsedSeconds(applied.session)).toBe(2);
    expect(sessionDistanceM(applied.session)).toBe(3);
  });
});

/**
 * GET /office/leaderboard — the live office leaderboard.
 *
 * Ranks an office's real patients from stored weights and activity signals
 * (see ../leaderboard/ranking.ts for the definitions). Scope follows the
 * other live office endpoints: provider staff are always their own office
 * (any `office` query is ignored); HQ names an office with `office=<id>`
 * and, additionally here, may ask for every enabled office at once with
 * `office=all` — the network-wide board HQ analytics already implies.
 *
 * Query
 *   period  program | 30d | 90d          (default program)
 *   stage   protocol | maintenance | all (default all) — ranks are computed
 *           within the filtered set, so the client never re-ranks
 *   office  HQ only: an office id, or `all`
 *
 * Response
 *   { office, offices, period, asOf, rows, notRankable, definitions }
 *   rows carry every metric AND a competition rank per metric; the client
 *   picks a metric and orders by that rank. A live failure is a 502 — the
 *   apps never fall back to seeded rows.
 */
import { Router } from "express";
import { resolveOfficeScope, respondOfficeScopeDenied } from "../auth/office-scope";
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  buildLeaderboard,
  LEADERBOARD_DEFINITIONS,
  NOT_RANKABLE_LABELS,
  PERIOD_WINDOW_DAYS,
  parsePeriod,
  parseStage,
  type LeaderboardFactRow,
  type LeaderboardPatientInput,
} from "../leaderboard/ranking";
import { patientDto, PATIENT_SELECT, type PatientRosterRow } from "./office-roster";
import { dayKeyInTimeZone } from "../lib/local-day";

const router = Router();
const SERVER_ERROR = "The leaderboard could not be loaded right now. Please try again.";
const enc = (value: string) => encodeURIComponent(value);

interface OfficeRow {
  provider_id: string;
  office_name: string | null;
  provider_name: string | null;
  access_disabled: boolean | null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function factRow(raw: Record<string, unknown>): LeaderboardFactRow {
  return {
    patient_id: String(raw.patient_id),
    provider_id: String(raw.provider_id ?? ""),
    as_of_date: String(raw.as_of_date ?? "").slice(0, 10),
    period_start: String(raw.period_start ?? "").slice(0, 10),
    eligible_days: numberOrNull(raw.eligible_days) ?? 0,
    logged_days: numberOrNull(raw.logged_days) ?? 0,
    check_in_days: numberOrNull(raw.check_in_days) ?? 0,
    water_goal_days: numberOrNull(raw.water_goal_days) ?? 0,
    weigh_in_count: numberOrNull(raw.weigh_in_count) ?? 0,
    period_weigh_ins: numberOrNull(raw.period_weigh_ins) ?? 0,
    baseline_weight: numberOrNull(raw.baseline_weight),
    baseline_weight_date: typeof raw.baseline_weight_date === "string" ? raw.baseline_weight_date.slice(0, 10) : null,
    latest_weight: numberOrNull(raw.latest_weight),
    latest_weight_date: typeof raw.latest_weight_date === "string" ? raw.latest_weight_date.slice(0, 10) : null,
  };
}

/**
 * The roster's own DTO is the source of names, stages and program facts, so
 * both surfaces agree. `asOf` MUST be the patient's own local day (the facts
 * RPC's `as_of_date`): program day and stage are day-granular, so a single
 * UTC date would put patients west/east of UTC on the wrong day around
 * midnight and let the stage filter pick the wrong cohort.
 */
export function leaderboardPatientInput(row: PatientRosterRow, asOf: string, pendingDeletion: boolean): LeaderboardPatientInput {
  // Legacy rows have no program_start_date. The facts RPC treats their
  // program start as the account-creation LOCAL day; mirror that here so a
  // rankable legacy patient still gets a program day/stage (and survives the
  // stage filter) instead of dropping out with a null stage.
  const createdAt = typeof row.created_at === "string" ? new Date(row.created_at) : null;
  const programStart =
    row.program_start_date ??
    (createdAt && Number.isFinite(createdAt.getTime())
      ? dayKeyInTimeZone(typeof row.timezone === "string" ? row.timezone : null, createdAt)
      : null);
  const dto = patientDto(programStart ? { ...row, program_start_date: programStart } : row, asOf);
  return {
    id: dto.id,
    providerId: String(row.provider_id ?? ""),
    name: dto.name,
    activationStatus: dto.activationStatus,
    deletionRequested: dto.deletion != null || pendingDeletion,
    startingWeight: dto.program.startingWeight,
    goalWeight: dto.program.goalWeight,
    program: {
      startDate: dto.program.startDate,
      day: dto.program.day,
      stage: dto.program.stage === "protocol" || dto.program.stage === "maintenance" ? dto.program.stage : null,
      week: dto.program.week,
    },
  };
}

type Target = { kind: "office"; providerId: string; officeName: string } | { kind: "all" };

router.get("/office/leaderboard", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    if (!period) {
      res.status(400).json({ error: "period must be one of program, 30d or 90d." });
      return;
    }
    const stage = parseStage(req.query.stage);
    if (stage === undefined) {
      res.status(400).json({ error: "stage must be protocol, maintenance or all." });
      return;
    }
    const explicitOffice = typeof req.query.office === "string" ? req.query.office : null;

    let target: Target;
    if (explicitOffice === "all") {
      // Network-wide board. Resolution order is EXACTLY the shared office
      // ladder: a provider owner or team member is always pinned to their
      // own office (even one who also holds an HQ membership), deactivated /
      // locked / disabled identities fail closed there, and only an identity
      // with no office association that reaches the HQ rung with
      // provider_read is asked for an office — that "office_required"
      // denial is the one signal that "all" is allowed.
      const resolved = await resolveOfficeScope({ authorization: req.headers.authorization, request: req, explicitOfficeId: null, hqPermission: "provider_read", requireUnlocked: false });
      if (resolved.kind === "ok") {
        target = { kind: "office", providerId: resolved.scope.providerId, officeName: resolved.scope.officeName };
      } else if (resolved.reason === "office_required") {
        target = { kind: "all" };
      } else {
        respondOfficeScopeDenied(req, res, resolved);
        return;
      }
    } else {
      const resolved = await resolveOfficeScope({ authorization: req.headers.authorization, request: req, explicitOfficeId: explicitOffice, hqPermission: "provider_read", requireUnlocked: false });
      if (resolved.kind !== "ok") {
        respondOfficeScopeDenied(req, res, resolved);
        return;
      }
      target = { kind: "office", providerId: resolved.scope.providerId, officeName: resolved.scope.officeName };
    }

    const now = new Date();
    // UTC date the board was computed on; per-row `asOfDate` is each patient's local day.
    const computedOn = now.toISOString().slice(0, 10);
    const providerFilter = target.kind === "office" ? `provider_id=eq.${enc(target.providerId)}&` : "";
    const [patientsRes, factsRes, deletionsRes, officesRes] = await Promise.all([
      supabaseAdmin("GET", `/rest/v1/patients?${providerFilter}archived_at=is.null&select=${PATIENT_SELECT}&order=created_at.desc&limit=5000`),
      supabaseAdmin("POST", "/rest/v1/rpc/provider_leaderboard_facts", {
        p_provider_id: target.kind === "office" ? target.providerId : null,
        p_at: now.toISOString(),
        p_window_days: PERIOD_WINDOW_DAYS[period],
      }),
      supabaseAdmin("GET", `/rest/v1/patient_deletion_requests?${providerFilter}status=in.(pending,held)&select=patient_id&limit=5000`),
      target.kind === "all"
        ? supabaseAdmin("GET", "/rest/v1/providers?select=provider_id,office_name,provider_name,access_disabled&order=office_name.asc.nullslast,provider_id.asc&limit=2000")
        : Promise.resolve({ status: 200, json: [] as OfficeRow[] }),
    ]);
    if (patientsRes.status >= 300) throw new Error(`leaderboard patients load failed (${patientsRes.status})`);
    if (factsRes.status >= 300) throw new Error(`leaderboard facts load failed (${factsRes.status})`);
    if (deletionsRes.status >= 300) throw new Error(`leaderboard deletions load failed (${deletionsRes.status})`);
    if (officesRes.status >= 300) throw new Error(`leaderboard offices load failed (${officesRes.status})`);

    const offices = new Map<string, { providerId: string; officeName: string }>();
    if (target.kind === "all") {
      for (const row of Array.isArray(officesRes.json) ? (officesRes.json as OfficeRow[]) : []) {
        // Disabled offices fail closed everywhere else; keep them off the board too.
        if (row.access_disabled === true) continue;
        offices.set(row.provider_id, { providerId: row.provider_id, officeName: row.office_name?.trim() || row.provider_name?.trim() || row.provider_id });
      }
    } else {
      offices.set(target.providerId, { providerId: target.providerId, officeName: target.officeName });
    }
    const pendingDeletion = new Set(
      (Array.isArray(deletionsRes.json) ? (deletionsRes.json as Array<Record<string, unknown>>) : []).map((row) => String(row.patient_id)),
    );
    const facts = (Array.isArray(factsRes.json) ? (factsRes.json as Array<Record<string, unknown>>) : []).map(factRow);
    // Each patient's program day/stage is derived on THEIR local day, exactly
    // the day the facts were sliced on. The request's UTC date is only the
    // fallback for a patient the RPC returned no row for (never rankable).
    const localDay = new Map(facts.map((fact) => [fact.patient_id, fact.as_of_date] as const));
    const patients = (Array.isArray(patientsRes.json) ? (patientsRes.json as PatientRosterRow[]) : [])
      .filter((row) => offices.has(String(row.provider_id)))
      .map((row) => leaderboardPatientInput(row, localDay.get(String(row.id)) || computedOn, pendingDeletion.has(String(row.id))));

    const board = buildLeaderboard({ patients, facts, period, stage });
    res.json({
      office: target.kind === "office" ? { providerId: target.providerId, officeName: target.officeName } : null,
      offices: [...offices.values()],
      period,
      stage: stage ?? "all",
      asOf: computedOn,
      windowDays: PERIOD_WINDOW_DAYS[period],
      rows: board.rows.map((row) => ({ ...row, officeName: offices.get(row.providerId)?.officeName ?? null })),
      notRankable: {
        total: board.notRankable.total,
        reasons: Object.entries(board.notRankable.reasons).map(([reason, count]) => ({
          reason,
          label: NOT_RANKABLE_LABELS[reason as keyof typeof NOT_RANKABLE_LABELS],
          count,
        })),
      },
      definitions: LEADERBOARD_DEFINITIONS,
    });
  } catch (error) {
    req.log?.error({ err: error }, "office leaderboard failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

export default router;

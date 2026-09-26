interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * JECFA (Joint FAO/WHO Expert Committee on Food Additives) — safety evaluations,
 * Acceptable Daily Intakes and specifications for food additives, flavourings,
 * contaminants and veterinary drug residues.
 *
 * Upstream is the WHO's database at apps.who.int. It has no documented API; the
 * endpoints below back the site's own Kendo grid and were read off the page.
 * Three of them behave in ways that produce confidently wrong answers if taken
 * at face value — each is guarded at the point it's used:
 *
 *   1. /SearchChemical/ByPartialName echoes the query back as a synthetic row
 *      with Id 0. It is the UI's "search for this literal string" affordance,
 *      not a substance, and it always carries a blank ADI.
 *   2. That same endpoint returns CAS_NO and FunctionalClass as null even when
 *      you searched BY a CAS number. Only /ChemicalData/GetBy/par returns the
 *      populated record, so that is what search actually calls.
 *   3. /ChemicalData/GetBy/fir wants the character ("A"), while the companion
 *      /FilterData/Get/FirstCharacter hands you its char code (65). Passing the
 *      code 500s.
 *
 * INS (E-)numbers are not searchable upstream at all — see INS_INDEX below.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'JECFA');
}

const BASE = 'https://apps.who.int/food-additives-contaminants-jecfa-database';
const UA = 'pipeworx-mcp-jecfa/1.0 (+https://pipeworx.io)';

// ─── INS_INDEX:START (generated by scripts/build-ins-index.mjs) ───
// 486 of 777 food additives carry an INS; 516 lookup keys,
// 56 of them ambiguous. Each INS is also indexed without its roman-numeral
// suffix and as bare digits, so "E160" reaches all six carotene subdivisions.
const INS_INDEX: Record<string, number[]> = {
  '100': [1355, 3750],
  '100i': [1355],
  '100ii': [3750],
  '101': [4091, 4092, 4093],
  '101i': [4091],
  '101ii': [4093],
  '101iii': [4092],
  '102': [3885],
  '103': [2359],
  '104': [3466],
  '107': [3225],
  '110': [2703],
  '120': [1079],
  '121': [1457],
  '122': [1704],
  '123': [996],
  '124': [4941],
  '125': [223],
  '127': [3740],
  '128': [228],
  '129': [2361],
  '131': [2513],
  '132': [2109],
  '133': [3309],
  '134': [6471],
  '140': [369],
  '141': [630, 953],
  '141i': [630],
  '141ii': [953],
  '142': [611],
  '143': [1356],
  '150': [423, 424, 498, 1668],
  '150a': [423],
  '150b': [424],
  '150c': [498],
  '150d': [1668],
  '151': [399],
  '152': [2071],
  '153': [2323],
  '154': [1274],
  '155': [3815],
  '160': [65, 375, 742, 941, 1320, 1514, 2706, 2876, 3445, 3652, 3654, 3898, 4372, 4486, 4743, 5572, 5573, 5866, 5880],
  '160a': [65, 742, 1320, 1514],
  '160ai': [1514],
  '160aii': [1320],
  '160aiii': [65],
  '160aiv': [742],
  '160b': [2706, 3445, 3652, 3654, 3898, 4372, 4743],
  '160c': [4486, 5866],
  '160ci': [4486],
  '160cii': [5866],
  '160d': [2876, 5572, 5573, 5880],
  '160di': [5572],
  '160dii': [5880],
  '160diii': [5573],
  '160e': [941],
  '160f': [375],
  '161': [1268, 2179, 2964, 4904, 4907, 4908],
  '161b': [2179, 2964, 4904],
  '161bi': [4904],
  '161bii': [2964],
  '161g': [1268],
  '161h': [4907, 4908],
  '161hi': [4907],
  '161hii': [4908],
  '162': [877],
  '163': [125, 1445, 1491],
  '163ii': [1445],
  '163iii': [125],
  '164': [6197],
  '165': [6604],
  '170': [457, 1528],
  '170i': [457],
  '170ii': [1528],
  '171': [2723],
  '172': [947, 948, 949, 4080],
  '172i': [4080],
  '172ii': [947],
  '172iii': [948],
  '173': [1756],
  '174': [3411],
  '175': [1287],
  '180': [2870],
  '181': [3751],
  '182': [2926],
  '183': [6461],
  '200': [2443],
  '201': [4755],
  '202': [2724],
  '203': [2088],
  '210': [4530],
  '211': [1098],
  '212': [2283],
  '213': [452],
  '214': [2695],
  '216': [3045],
  '218': [342],
  '220': [985],
  '221': [2993],
  '222': [2269],
  '223': [1824],
  '224': [2272],
  '225': [2483],
  '227': [81],
  '228': [2445],
  '230': [957],
  '231': [5214],
  '232': [5232],
  '234': [572],
  '235': [3255],
  '236': [1561],
  '239': [1720],
  '242': [1032],
  '243': [5865],
  '249': [2842],
  '250': [4792],
  '251': [1569],
  '252': [390],
  '260': [4785],
  '261': [3218],
  '261i': [3218],
  '262': [1654, 2970],
  '262i': [2970],
  '262ii': [1654],
  '263': [2804],
  '264': [438],
  '270': [3367],
  '280': [3438],
  '281': [3999],
  '282': [2163],
  '283': [2401],
  '290': [592],
  '296': [5163],
  '297': [1723],
  '300': [59],
  '301': [2372],
  '302': [1348],
  '303': [3233],
  '304': [60],
  '305': [61],
  '306': [3027],
  '307': [22, 3025, 4871],
  '307a': [22],
  '307b': [4871],
  '307c': [3025],
  '310': [1272],
  '311': [4118],
  '312': [1885],
  '314': [861],
  '315': [2602],
  '316': [2641],
  '319': [236],
  '320': [2140],
  '321': [2142],
  '322': [1477, 1478],
  '322i': [1477],
  '323': [2707],
  '325': [1552],
  '326': [2777],
  '327': [88],
  '328': [136],
  '329': [3000],
  '330': [3594],
  '331': [349, 2709],
  '331i': [2709],
  '331iii': [349],
  '332': [366, 959],
  '332i': [959],
  '332ii': [366],
  '333': [2938],
  '334': [4746],
  '335': [2062, 2318],
  '335i': [2062],
  '335ii': [2318],
  '336': [1695],
  '336ii': [1695],
  '337': [2377],
  '338': [2530],
  '339': [823, 2639, 2989],
  '339i': [2639],
  '339ii': [823],
  '339iii': [2989],
  '340': [1532, 1802, 2985],
  '340i': [1532],
  '340ii': [1802],
  '340iii': [2985],
  '341': [80, 607, 3792],
  '341i': [3792],
  '341ii': [80],
  '341iii': [607],
  '342': [569, 680],
  '342i': [680],
  '342ii': [569],
  '343': [333, 1541],
  '343ii': [1541],
  '343iii': [333],
  '350': [601, 4441],
  '350i': [601],
  '350ii': [4441],
  '351': [1877, 2287],
  '351i': [2287],
  '351ii': [1877],
  '352': [90],
  '352ii': [90],
  '353': [6462],
  '354': [1362, 1400],
  '355': [194],
  '356': [2972],
  '357': [3636],
  '359': [928],
  '365': [2762],
  '366': [3530],
  '367': [2189],
  '380': [504],
  '381': [1775],
  '384': [2344],
  '385': [3011],
  '386': [386],
  '387': [4154],
  '388': [262],
  '389': [2124],
  '390': [588],
  '392': [6311],
  '400': [1159],
  '401': [1823],
  '402': [3122],
  '403': [879],
  '404': [2806],
  '405': [585],
  '406': [1163],
  '407': [377, 4387],
  '407a': [4387],
  '410': [940],
  '411': [3099],
  '412': [863],
  '413': [2211],
  '414': [865],
  '415': [802],
  '416': [1],
  '417': [4115],
  '418': [2056],
  '420': [3018, 3856],
  '420i': [3018],
  '420ii': [3856],
  '421': [5119],
  '422': [1565],
  '423': [5881],
  '424': [1085],
  '425': [3547],
  '427': [5876],
  '430': [3587],
  '431': [2416],
  '432': [2878],
  '433': [2507],
  '434': [3584],
  '435': [3585],
  '436': [3586],
  '440': [3043],
  '442': [2973],
  '443': [2686],
  '444': [508],
  '445': [2855, 5878, 5879],
  '445i': [5878],
  '445ii': [5879],
  '445iii': [2855],
  '450': [2171, 3616, 3791, 4139, 4480, 4482, 6180],
  '450i': [4139],
  '450ii': [3616],
  '450iii': [4482],
  '450ix': [6180],
  '450v': [4480],
  '450vi': [2171],
  '450vii': [3791],
  '451': [2181, 2834],
  '451i': [2181],
  '451ii': [2834],
  '452': [984, 2162, 2400, 2670, 4669],
  '452i': [4669],
  '452ii': [2400],
  '452iii': [984],
  '452iv': [2162],
  '452v': [2670],
  '456': [6505],
  '459': [2066],
  '460': [251, 281],
  '460ii': [251],
  '461': [700],
  '462': [3196],
  '463': [609],
  '464': [2510],
  '465': [2161],
  '466': [3773],
  '467': [3203],
  '468': [2977],
  '469': [3706],
  '470': [1443, 2215, 3037, 3235, 3236, 3487, 4275, 4795],
  '470i': [3037, 3487],
  '470ii': [1443],
  '470iii': [4275],
  '471': [917],
  '472': [434, 1126, 1275, 2339, 2411, 3714],
  '472a': [434],
  '472b': [2411],
  '472c': [1275],
  '472e': [1126],
  '472f': [3714],
  '472g': [2339],
  '473': [2736, 5882],
  '473a': [5882],
  '474': [2341],
  '475': [3561],
  '476': [4009],
  '477': [683],
  '479': [2463],
  '480': [954],
  '481': [3446],
  '481i': [3446],
  '482': [3053],
  '482i': [3053],
  '483': [5181],
  '484': [2448],
  '491': [2271],
  '492': [3983],
  '493': [246],
  '494': [3008],
  '495': [3009],
  '500': [1892, 3252, 4004],
  '500i': [3252],
  '500ii': [1892],
  '500iii': [4004],
  '501': [2286, 2711],
  '501i': [2711],
  '501ii': [2286],
  '503': [133, 1215],
  '503i': [1215],
  '503ii': [133],
  '504': [2882, 4697],
  '504i': [4697],
  '504ii': [2882],
  '507': [2799],
  '508': [1874],
  '509': [458],
  '510': [3028],
  '511': [3331],
  '512': [4291],
  '513': [2101],
  '514': [3447, 5692],
  '514i': [3447],
  '514ii': [5692],
  '515': [2482],
  '516': [1360],
  '518': [3645],
  '519': [1353],
  '520': [730],
  '521': [844],
  '522': [2374],
  '522dodecahydrate': [2374],
  '523': [299],
  '524': [3939],
  '525': [2446],
  '526': [82],
  '527': [437],
  '528': [2881],
  '529': [94],
  '530': [2376],
  '535': [2761],
  '536': [3529],
  '538': [2828],
  '539': [1812],
  '541': [2288, 4655],
  '541i': [4655],
  '541ii': [2288],
  '542': [1044],
  '551': [2462],
  '552': [1559],
  '553': [2965, 4274],
  '553i': [4274],
  '553iii': [2965],
  '554': [2371],
  '555': [3124],
  '556': [1347],
  '558': [699],
  '559': [843],
  '574': [2851],
  '575': [1370],
  '576': [2763],
  '577': [4660],
  '578': [2190],
  '579': [1395],
  '580': [2769],
  '585': [1497],
  '620': [668],
  '621': [2257],
  '622': [4073],
  '623': [3790],
  '624': [468],
  '625': [2708],
  '626': [862],
  '627': [822],
  '628': [1801],
  '629': [1527],
  '630': [566],
  '631': [2512],
  '632': [1803],
  '633': [83],
  '634': [2165],
  '635': [4140],
  '636': [2915],
  '637': [4705],
  '900': [2755],
  '900a': [2755],
  '901': [168],
  '902': [1401],
  '903': [939],
  '904': [1749],
  '905': [282, 2053, 2803, 3021, 3110, 3896, 3997, 4641],
  '905a': [2803],
  '905b': [3110],
  '905c': [282, 3021],
  '905d': [4641],
  '905e': [2053],
  '905f': [3896],
  '905g': [3997],
  '907': [722],
  '916': [887],
  '917': [2776],
  '922': [3683],
  '923': [2150],
  '924': [4265],
  '924a': [4265],
  '925': [552],
  '926': [1422],
  '927': [538],
  '927a': [538],
  '928': [171],
  '929': [2012],
  '930': [111],
  '938': [1861],
  '939': [1880],
  '940': [647],
  '941': [1040],
  '942': [1090],
  '943': [159],
  '944': [3112],
  '948': [2739],
  '950': [926],
  '951': [62],
  '952': [837, 995, 1653],
  '952i': [995],
  '952ii': [837],
  '952iv': [1653],
  '953': [1289],
  '954': [980, 1724, 3164, 4003],
  '954ii': [1724],
  '954iii': [980],
  '954iv': [4003],
  '955': [2340],
  '956': [1160],
  '957': [4169],
  '959': [6609],
  '960': [267],
  '961': [5107],
  '962': [1849],
  '965': [4276, 4277],
  '965i': [4276],
  '965ii': [4277],
  '966': [3084],
  '967': [2620],
  '970': [6608],
  '999': [2305, 4831, 4832],
  '999i': [4831],
  '999ii': [4832],
  '1000': [1950],
  '1001': [1951],
  '1100': [339, 766, 1050, 1957, 2928],
  '1101': [1481, 2685, 3019, 3987],
  '1101i': [3987],
  '1101ii': [3019],
  '1101iii': [2685],
  '1101iv': [1481],
  '1102': [665, 1476],
  '1103': [1726],
  '1104': [1664],
  '1105': [3398],
  '1200': [2754],
  '1201': [4938],
  '1202': [919],
  '1203': [4829],
  '1204': [4523],
  '1205': [6474],
  '1206': [6472],
  '1207': [6473],
  '1209': [6192],
  '1400': [2553],
  '1401': [2036],
  '1402': [2358],
  '1403': [273],
  '1404': [889],
  '1405': [2884],
  '1410': [2816],
  '1411': [2822],
  '1412': [3281],
  '1413': [1068],
  '1414': [1765],
  '1420': [4292],
  '1422': [78],
  '1423': [79],
  '1440': [3694],
  '1442': [2343],
  '1450': [340],
  '1451': [178],
  '1503': [96],
  '1505': [3286],
  '1518': [3893],
  '1520': [2698],
  '1521': [212],
};
// ─── INS_INDEX:END ───

/**
 * The four umbrella ids are the only way to enumerate the database: there is no
 * "list everything" endpoint, and paging the alphabet costs 26+ requests.
 */
const GROUPS: Record<string, { id: number; label: string }> = {
  food_additives: { id: -1, label: 'Food Additives' },
  food_contaminants: { id: -2, label: 'Food Contaminant' },
  veterinary_drugs: { id: -3, label: 'Veterinary Drug' },
  flavouring_agents: { id: -4, label: 'Flavouring Agent' },
};

interface ChemicalRow {
  Id: number;
  Name: string | null;
  ADI: string | null;
  CAS_NO: string | null;
  FEMA_NO: string | null;
  JECFA_NO: string | null;
  FunctionalClass: string | null;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'jecfa_search',
    description:
      'Look up a food additive, flavouring, contaminant or veterinary drug in the WHO/FAO JECFA database by substance name, CAS number, or INS/E-number (E951, INS 951, 160a). Returns the Acceptable Daily Intake (ADI), CAS number, functional class and a chemical id for fetching the full safety evaluation. Use this to answer whether a substance has been evaluated for safety and what intake level was judged acceptable.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Substance name or fragment ("aspartame", "sunset yellow"), CAS number ("22389-47-0"), or INS/E-number ("E951", "951", "160a(iii)").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'jecfa_chemical',
    description:
      'Fetch the complete JECFA record for one substance by its chemical id: chemical and synonym names, CAS and INS numbers, functional class, and every safety evaluation JECFA has made of it — evaluation year, ADI, the committee’s conclusions, dietary exposure findings, meeting number, and the TRS report and toxicological monograph citations. Use after search to explain how and when an ADI was set or revised.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Chemical id from jecfa_search (e.g. 62 for aspartame).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'jecfa_by_functional_class',
    description:
      'List every substance JECFA has evaluated in one functional class — sweeteners, preservatives, colours, emulsifiers, antioxidants and so on — or every substance in one of the four groups: food_additives, flavouring_agents, food_contaminants, veterinary_drugs. Each entry carries its ADI and CAS number. Use to survey what is permitted in a category rather than to look up a single substance.',
    inputSchema: {
      type: 'object',
      properties: {
        functional_class: {
          type: 'string',
          description:
            'Class name ("sweetener", "preservative"), group name ("food_additives"), or a numeric class id from jecfa_functional_classes.',
        },
      },
      required: ['functional_class'],
    },
  },
  {
    name: 'jecfa_functional_classes',
    description:
      'List the JECFA functional-class vocabulary — the 71 technological purposes a substance can be evaluated under (sweetener, emulsifier, antioxidant, humectant…), grouped into food additives, flavouring agents, food contaminants and veterinary drugs. Call this to discover the exact class name that jecfa_by_functional_class expects.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'jecfa_by_number',
    description:
      'Resolve a FEMA number or a JECFA substance number to its evaluated substance. These identifiers appear in flavouring literature and JECFA meeting reports. For INS/E-numbers use jecfa_search instead.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'FEMA or JECFA number, e.g. "1" or "2001".' },
      },
      required: ['number'],
    },
  },
  {
    name: 'jecfa_recent_evaluations',
    description:
      'Show the substances most recently added or re-evaluated by JECFA, with their current ADI and functional class. Use to check what the committee has looked at lately rather than to look up a known substance.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── HTTP ──────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const res = await pwFetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (!res.ok) throw await httpError(res, 'JECFA');
  return res.json() as Promise<T>;
}

async function getHtml(path: string): Promise<string> {
  const res = await pwFetch(`${BASE}${path}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw await httpError(res, 'JECFA');
  return res.text();
}

// ── Parsing ───────────────────────────────────────────────────────────

/**
 * Upstream leaks broken markup into a few evaluation fields — a stray `">` from
 * an unterminated anchor shows up glued to citations like `">TRS 1000-JECFA
 * 82/81`. Strip tags first, then that artifact, then entities.
 */
function clean(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/"\s*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Overview fields render as <div class="label">X</div><div class="value">Y</div>. */
function overviewField(html: string, label: string): string | null {
  const m = html.match(
    new RegExp(`<div class="label">\\s*${label}\\s*</div>\\s*<div class="value">([\\s\\S]*?)</div>`, 'i'),
  );
  if (!m) return null;
  return clean(m[1]) || null;
}

/** A cited document: the TRS report, toxicological monograph or specification.
 *  `url` is upstream's own link — usually a direct PDF on iris.who.int. */
interface Citation {
  title: string;
  url: string | null;
}

interface Evaluation {
  year: number | null;
  adi: string | null;
  comments: string | null;
  intake: string | null;
  meeting: string | null;
  specs_code: string | null;
  report: Citation | null;
  tox_monograph: Citation | null;
  specification: Citation | null;
  previous_years: string[];
}

/**
 * Evaluations are a flat run of `<h4>Evaluation year: YYYY</h4>` headings, each
 * followed by `<div class="row">Label:</div><div>value</div>` pairs until the
 * next heading. There is no wrapper element per evaluation, so the split is on
 * the headings themselves.
 */
function parseEvaluations(html: string): Evaluation[] {
  const section = html.split(/<h3>\s*Evaluations\s*<\/h3>/i)[1];
  if (!section) return [];

  const chunks = section.split(/<h4[^>]*>\s*Evaluation year:\s*/i).slice(1);
  return chunks.map((chunk) => {
    const year = parseInt(clean(chunk.slice(0, 40)), 10);
    const rows = new Map<string, { text: string; url: string | null }[]>();
    // The value column is col-sm-8 for prose fields but col-md-8 for the three
    // cited-document rows, which also wrap their text in an <a>. Matching only
    // col-sm-8 silently dropped every report and monograph citation.
    const re =
      /<div class="col-sm-2"[^>]*>([\s\S]*?)<\/div>\s*<div class="col-(?:sm|md)-8"[^>]*>([\s\S]*?)<\/div>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk)) !== null) {
      const key = clean(m[1]).replace(/:$/, '').toLowerCase();
      const raw = m[2];
      const text = clean(raw);
      if (!key || !text) continue;
      const url = raw.match(/href="([^"]+)"/i)?.[1]?.trim() ?? null;
      const bucket = rows.get(key) ?? [];
      // "Previous Years" repeats verbatim in the markup; keep one copy.
      if (!bucket.some((b) => b.text === text)) bucket.push({ text, url });
      rows.set(key, bucket);
    }
    const one = (k: string) => rows.get(k)?.[0]?.text ?? null;
    const cite = (k: string): Citation | null => {
      const hit = rows.get(k)?.[0];
      return hit ? { title: hit.text, url: hit.url } : null;
    };
    return {
      year: Number.isFinite(year) ? year : null,
      adi: one('adi'),
      comments: one('comments'),
      intake: one('intake'),
      meeting: one('meeting'),
      specs_code: one('specs code'),
      report: cite('report'),
      tox_monograph: cite('tox monograph'),
      specification: cite('specification'),
      previous_years: (rows.get('previous years') ?? []).flatMap((v) =>
        v.text.split('\n').map((s) => s.trim()).filter(Boolean),
      ),
    };
  });
}

// ── INS handling ──────────────────────────────────────────────────────

/**
 * Upstream is inconsistent about sub-forms: the same concept is written both
 * "100(i)" and "100i" across records. Collapsing to alphanumerics makes the two
 * spellings one key, which is why the generated index and the query take the
 * identical path through this function.
 */
export function normalizeIns(raw: string): string[] {
  const ins = raw.toLowerCase().replace(/^e/, '').replace(/[^a-z0-9]/g, '');
  if (!ins || !/^\d/.test(ins)) return [];
  const keys = [ins];
  const noRoman = ins.replace(/(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/, '');
  if (noRoman && noRoman !== ins) keys.push(noRoman);
  const bare = ins.match(/^\d+/);
  if (bare && !keys.includes(bare[0])) keys.push(bare[0]);
  return keys;
}

function looksLikeIns(query: string): boolean {
  return /^e?\s*\d{2,4}\s*(?:\([ivx]+\)|[a-z]\s*(?:\([ivx]+\))?)?$/i.test(query.trim());
}

function resolveIns(query: string): number[] | null {
  for (const key of normalizeIns(query)) {
    const ids = INS_INDEX[key];
    if (ids?.length) return ids;
  }
  return null;
}

// ── Shaping ───────────────────────────────────────────────────────────

function shapeRow(r: ChemicalRow) {
  return {
    id: r.Id,
    name: r.Name,
    adi: r.ADI || null,
    cas_number: r.CAS_NO || null,
    functional_class: r.FunctionalClass || null,
    fema_number: r.FEMA_NO || null,
    jecfa_number: r.JECFA_NO || null,
  };
}

/**
 * Drop the Id-0 echo row. Upstream prepends the raw query string as a fake
 * result so the autocomplete can offer "search for this text"; it has a blank
 * ADI and no CAS, and passing it on invents a substance that was never
 * evaluated.
 */
function realRows(rows: ChemicalRow[]): ChemicalRow[] {
  return rows.filter((r) => r && r.Id > 0);
}

async function chemicalDetail(id: number) {
  const html = await getHtml(`/Home/Chemical/${id}`);
  const name = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '') || null;
  const evaluations = parseEvaluations(html);
  if (!name && evaluations.length === 0) {
    return {
      found: false as const,
      reason: 'unknown_id',
      id,
      hint: 'No JECFA record with that id. Ids come from jecfa_search or jecfa_by_functional_class — they are not INS or CAS numbers.',
    };
  }
  return {
    found: true as const,
    id,
    name,
    chemical_names: overviewField(html, 'Chemical Names'),
    synonyms: overviewField(html, 'Synonyms'),
    cas_number: overviewField(html, 'CAS number'),
    ins_number: overviewField(html, 'INS'),
    functional_class: overviewField(html, 'Functional Class'),
    evaluations,
    source_url: `${BASE}/Home/Chemical/${id}`,
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'jecfa_search': {
      const query = reqStr(args, 'query', '"aspartame" or "E951"');

      if (looksLikeIns(query)) {
        const ids = resolveIns(query);
        if (ids?.length === 1) {
          return { matched_by: 'ins_number', query, ...(await chemicalDetail(ids[0])) };
        }
        if (ids && ids.length > 1) {
          // A bare INS covering subdivisions (160 → the six carotenes). Name all
          // of them rather than picking one: the caller asked about a number
          // that genuinely denotes several evaluated substances.
          const all = realRows(await getJson<ChemicalRow[]>(`/api/ChemicalData/GetBy/fun/${GROUPS.food_additives.id}`));
          const byId = new Map(all.map((r) => [r.Id, r]));
          const results = ids.map((id) => byId.get(id)).filter((r): r is ChemicalRow => Boolean(r));
          return {
            found: true,
            matched_by: 'ins_number',
            ambiguous: true,
            query,
            count: results.length,
            results: results.map(shapeRow),
            hint: `INS ${query} covers ${results.length} separately evaluated substances. Call jecfa_chemical with one id for its full evaluation history.`,
          };
        }
        // Fall through to name search — a bare number can still be part of a
        // substance name, and saying "no such E-number" for "1422" when the
        // substance exists under another spelling would be wrong.
      }

      const rows = realRows(await getJson<ChemicalRow[]>(`/api/ChemicalData/GetBy/par/${encodeURIComponent(query)}`));
      if (rows.length === 0) {
        return {
          found: false,
          reason: 'no_match',
          query,
          hint: looksLikeIns(query)
            ? 'No substance with that INS/E-number, and no name match either. Only food additives carry INS numbers — flavourings use FEMA/JECFA numbers (try jecfa_by_number).'
            : 'No JECFA evaluation matched. Try a shorter fragment of the substance name, a CAS number, or browse a category with jecfa_by_functional_class.',
        };
      }
      return {
        found: true,
        matched_by: 'name_or_cas',
        query,
        count: rows.length,
        results: rows.map(shapeRow),
      };
    }

    case 'jecfa_chemical': {
      const id = args.id;
      if (typeof id !== 'number' || !Number.isFinite(id)) {
        throw new Error('Required argument "id" must be a number, e.g. 62. Get one from jecfa_search.');
      }
      return chemicalDetail(id);
    }

    case 'jecfa_by_functional_class': {
      const raw = reqStr(args, 'functional_class', '"sweetener" or "food_additives"');
      const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');

      let classId: number | null = null;
      let label = raw;
      if (GROUPS[key]) {
        classId = GROUPS[key].id;
        label = GROUPS[key].label;
      } else if (/^-?\d+$/.test(key)) {
        classId = parseInt(key, 10);
      } else {
        const classes = await getJson<{ Id: number; Name: string; GroupName: string | null }[]>(
          '/api/FilterData/Get/FunctionalClass',
        );
        const hit =
          classes.find((c) => c.Name.toLowerCase() === key) ??
          classes.find((c) => c.Name.toLowerCase().includes(key));
        if (!hit) {
          return {
            found: false,
            reason: 'unknown_functional_class',
            functional_class: raw,
            hint: 'Call jecfa_functional_classes for the exact vocabulary, or pass a group: food_additives, flavouring_agents, food_contaminants, veterinary_drugs.',
          };
        }
        classId = hit.Id;
        label = hit.Name;
      }

      const rows = realRows(await getJson<ChemicalRow[]>(`/api/ChemicalData/GetBy/fun/${classId}`));
      return {
        found: rows.length > 0,
        functional_class: label,
        functional_class_id: classId,
        count: rows.length,
        results: rows.map(shapeRow),
      };
    }

    case 'jecfa_functional_classes': {
      const classes = await getJson<{ Id: number; Name: string; GroupName: string | null }[]>(
        '/api/FilterData/Get/FunctionalClass',
      );
      return {
        count: classes.length,
        groups: Object.entries(GROUPS).map(([k, v]) => ({ name: k, label: v.label, id: v.id })),
        classes: classes.map((c) => ({ id: c.Id, name: c.Name, group: c.GroupName })),
      };
    }

    case 'jecfa_by_number': {
      const number = reqStr(args, 'number', '"1"');
      const rows = realRows(
        await getJson<ChemicalRow[]>(`/api/SearchChemical/ByFemaOrJecfa/${encodeURIComponent(number.trim())}`),
      );
      if (rows.length === 0) {
        return {
          found: false,
          reason: 'no_match',
          number,
          hint: 'No FEMA or JECFA number matched. INS/E-numbers are a different identifier — use jecfa_search for those.',
        };
      }
      // ByFemaOrJecfa is an autocomplete endpoint: it returns names and ADIs but
      // leaves CAS and functional class null. Re-fetch the populated record.
      const detailed = await getJson<ChemicalRow[]>(
        `/api/ChemicalData/GetBy/par/${encodeURIComponent(rows[0].Name ?? '')}`,
      );
      const full = realRows(detailed).find((r) => r.Id === rows[0].Id);
      return {
        found: true,
        number,
        count: rows.length,
        results: rows.map((r) => shapeRow(r.Id === full?.Id ? full : r)),
      };
    }

    case 'jecfa_recent_evaluations': {
      const rows = realRows(await getJson<ChemicalRow[]>('/api/ChemicalData/GetLatest'));
      return { found: rows.length > 0, count: rows.length, results: rows.map(shapeRow) };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

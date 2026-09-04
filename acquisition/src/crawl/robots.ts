// robots.txt parsing and path matching.
//
// This is the gate that decides whether we are allowed to fetch a URL at all,
// so it is deliberately a pure function with no I/O: it can be exhaustively
// unit tested, and no fetch path can bypass it by accident.
//
// Matching follows the widely-implemented Google rules: group selection by
// user-agent, `*` as a wildcard and `$` as an end anchor inside paths, and
// longest-match-wins with Allow beating Disallow on an equal-length tie.

export interface RobotsRule {
  allow: boolean;
  /** Raw path pattern as written in the file, e.g. "/private/*.json$" */
  path: string;
}

export interface RobotsGroup {
  /** Lowercased user-agent tokens this group applies to. */
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

/** An empty robots.txt (or a 404) means "everything is allowed". */
export const ALLOW_ALL: Robots = { groups: [], sitemaps: [] };

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines share one group; a rule line closes the
  // agent list, so the next User-agent starts a fresh group.
  let acceptingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;

    if (field === "sitemap") {
      sitemaps.push(value);
      continue;
    }

    if (field === "user-agent") {
      if (!current || !acceptingAgents) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
        acceptingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue; // rule before any user-agent — ignore
    acceptingAgents = false;

    if (field === "allow" || field === "disallow") {
      // "Disallow:" with an empty value means allow-all and is handled by the
      // `!value` guard above, which skips it — leaving no rule, i.e. allowed.
      current.rules.push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  }

  return { groups, sitemaps };
}

/**
 * Pick the group that applies to `userAgent`: the most specific matching
 * token wins, falling back to the `*` group, then to no group at all.
 */
export function groupFor(robots: Robots, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLen = -1;

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === "*") {
        if (bestLen < 0) best = group; // only if nothing specific matched yet
        continue;
      }
      if (ua.includes(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  return best;
}

/** Convert a robots path pattern into an anchored regex. */
function patternToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      source += ".*";
    } else if (ch === "$" && i === pattern.length - 1) {
      source += "$";
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + source);
}

/** Length of a pattern's literal prefix — used for longest-match precedence. */
function specificity(pattern: string): number {
  const star = pattern.indexOf("*");
  return star < 0 ? pattern.length : star;
}

export function isAllowed(robots: Robots, userAgent: string, path: string): boolean {
  const group = groupFor(robots, userAgent);
  if (!group || group.rules.length === 0) return true;

  let decision = true;
  let winning = -1;

  for (const rule of group.rules) {
    if (!patternToRegex(rule.path).test(path)) continue;
    const weight = specificity(rule.path);
    // Longest match wins; Allow beats Disallow at equal length.
    if (weight > winning || (weight === winning && rule.allow)) {
      winning = weight;
      decision = rule.allow;
    }
  }
  return decision;
}

export function crawlDelayFor(robots: Robots, userAgent: string): number | null {
  return groupFor(robots, userAgent)?.crawlDelayMs ?? null;
}
